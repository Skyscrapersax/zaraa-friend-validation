import {
  BLACKHOLE_DEVICE,
  FACETIME_AUDIO_SETUP_HINT,
  FT_MULTI_OUTPUT_DEVICE,
  buildFaceTimeDialUrls,
  isSpeechLikePcm16,
  parseSwitchAudioSourceList,
  resolveFaceTimeDeviceRoles
} from "./chunk-RABT6PUR.js";

// src/voice/facetime-voice.ts
import { EventEmitter } from "events";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var SAMPLE_RATE = 24e3;
var CHANNELS = 1;
var BITS = 16;
var FaceTimeCallSession = class _FaceTimeCallSession extends EventEmitter {
  closed = false;
  sttFn = null;
  ttsFn = null;
  chatFn = null;
  recProcess = null;
  /** Background silence stream — keeps FaceTime's audio gate open */
  silenceProcess = null;
  audioBuffer = [];
  vadTimer = null;
  static VAD_SILENCE_MS = 1800;
  // longer for phone call latency
  /** True while TTS is playing — capture is paused to avoid echo */
  isPlaying = false;
  callInfo;
  /** Saved audio devices to restore on hangup */
  savedInputDevice = null;
  savedOutputDevice = null;
  constructor(to) {
    super();
    this.callInfo = {
      to,
      state: "initiating",
      startedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  /** Configure the pipeline functions */
  configure(opts) {
    this.sttFn = opts.sttFn;
    this.ttsFn = opts.ttsFn;
    this.chatFn = opts.chatFn;
  }
  /**
   * Start capturing audio from BlackHole.
   * SoX records from the BlackHole virtual device in raw PCM format.
   */
  startCapture() {
    if (this.closed) return;
    this.recProcess = spawn("sox", [
      "-t",
      "coreaudio",
      BLACKHOLE_DEVICE,
      "-t",
      "raw",
      "-r",
      String(SAMPLE_RATE),
      // output at 24kHz
      "-c",
      String(CHANNELS),
      // output mono
      "-b",
      String(BITS),
      "-e",
      "signed",
      "-",
      // stdout
      "rate",
      String(SAMPLE_RATE),
      "channels",
      String(CHANNELS)
    ], { stdio: ["ignore", "pipe", "ignore"] });
    this.recProcess.stdout?.on("data", (chunk) => {
      if (this.closed || this.isPlaying) return;
      this.audioBuffer.push(chunk);
      this.resetVadTimer();
    });
    this.recProcess.on("error", (err) => {
      if (!this.closed) {
        this.emit("error", `Audio capture failed: ${err.message}`);
      }
    });
    this.recProcess.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.emit("error", `Audio capture exited with code ${code}`);
      }
    });
    this.callInfo.state = "in-progress";
  }
  // ── VoiceSession interface ─────────────────────────────────────
  sendAudio(chunk) {
    if (this.closed) return;
    this.audioBuffer.push(chunk);
  }
  commitAudio() {
    if (this.closed || !this.sttFn || !this.ttsFn || !this.chatFn) return;
    const fullAudio = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    if (fullAudio.length > 4800 && isSpeechLikePcm16(fullAudio)) {
      this.processAudio(fullAudio);
    }
  }
  /**
   * Start a continuous silence stream to BlackHole.
   * This keeps FaceTime's audio gate open — without it, FaceTime
   * detects no active audio source and mutes the mic input.
   * SoX generates an infinite stream of near-silent audio.
   */
  startSilenceStream() {
    if (this.silenceProcess || this.closed) return;
    this.silenceProcess = spawn("sox", [
      "-n",
      "-r",
      "48000",
      "-c",
      "2",
      "-t",
      "coreaudio",
      BLACKHOLE_DEVICE,
      "synth",
      "86400",
      "sine",
      "20",
      "vol",
      "0.0003"
    ], { stdio: ["ignore", "ignore", "ignore"] });
    this.silenceProcess.on("error", () => {
    });
    this.silenceProcess.on("exit", () => {
      this.silenceProcess = null;
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.vadTimer) clearTimeout(this.vadTimer);
    if (this.recProcess) {
      this.recProcess.kill();
      this.recProcess = null;
    }
    if (this.silenceProcess) {
      this.silenceProcess.kill();
      this.silenceProcess = null;
    }
    this.callInfo.state = "completed";
    this.callInfo.endedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (this.callInfo.startedAt) {
      this.callInfo.duration = Math.round(
        (Date.now() - new Date(this.callInfo.startedAt).getTime()) / 1e3
      );
    }
    this.audioBuffer = [];
    this.removeAllListeners();
  }
  setSavedDevices(input, output) {
    this.savedInputDevice = input;
    this.savedOutputDevice = output;
  }
  getSavedDevices() {
    return { input: this.savedInputDevice, output: this.savedOutputDevice };
  }
  // ── Internal ───────────────────────────────────────────────────
  resetVadTimer() {
    if (this.vadTimer) clearTimeout(this.vadTimer);
    this.vadTimer = setTimeout(() => {
      this.commitAudio();
    }, _FaceTimeCallSession.VAD_SILENCE_MS);
  }
  async processAudio(audio) {
    if (!this.sttFn || !this.ttsFn || !this.chatFn) return;
    try {
      const text = await this.sttFn(audio);
      if (!text.trim()) return;
      this.emit("transcript", text, true);
      let responseText = "";
      for await (const event of this.chatFn(text)) {
        if (this.closed) break;
        this.emit("agent_event", event);
        if (event.type === "response" && "content" in event) {
          responseText += event.content;
        }
      }
      if (responseText && !this.closed) {
        const pcmAudio = await this.ttsFn(responseText);
        this.emit("audio", pcmAudio);
        this.isPlaying = true;
        this.audioBuffer = [];
        try {
          await this.playToBlackHole(pcmAudio);
        } finally {
          await sleep(300);
          this.isPlaying = false;
          this.audioBuffer = [];
        }
      }
      if (!this.closed) {
        this.emit("done");
      }
    } catch (err) {
      if (!this.closed) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit("error", message);
      }
    }
  }
  /** Play PCM audio through BlackHole so FaceTime sends it to the caller.
   *  Input: 24kHz mono 16-bit signed PCM (from OpenAI TTS).
   *  BlackHole 2ch runs at 48kHz stereo — we convert via temp WAV file
   *  to avoid stdin pipe flushing issues with CoreAudio output. */
  async playToBlackHole(pcm) {
    const { writeFileSync, unlinkSync } = await import("fs");
    const tmpRaw = `/tmp/zaraa-tts-${Date.now()}.raw`;
    const tmpWav = `/tmp/zaraa-tts-${Date.now()}.wav`;
    try {
      writeFileSync(tmpRaw, pcm);
      await new Promise((resolve, reject) => {
        const conv = spawn("sox", [
          "-t",
          "raw",
          "-r",
          String(SAMPLE_RATE),
          "-c",
          String(CHANNELS),
          "-b",
          String(BITS),
          "-e",
          "signed",
          tmpRaw,
          "-r",
          "48000",
          "-c",
          "2",
          tmpWav,
          "norm",
          // normalize to max volume without clipping
          "pad",
          "0",
          "0.5"
          // 0.5s silence at end to prevent cutoff
        ], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        conv.stderr?.on("data", (d) => {
          stderr += d.toString();
        });
        conv.on("error", reject);
        conv.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`SoX convert failed ${code}: ${stderr}`));
        });
      });
      await setAudioDevice("input", BLACKHOLE_DEVICE).catch(() => {
      });
      await new Promise((resolve, reject) => {
        const play = spawn("sox", [
          tmpWav,
          "-t",
          "coreaudio",
          "-r",
          "48000",
          "-c",
          "2",
          BLACKHOLE_DEVICE,
          // Extra gain: remote parties were reporting silence / too quiet
          "gain",
          "-n",
          "-1"
        ], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        play.stderr?.on("data", (d) => {
          stderr += d.toString();
        });
        play.on("error", reject);
        play.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`SoX playback failed ${code}: ${stderr}`));
        });
      });
    } finally {
      try {
        unlinkSync(tmpRaw);
      } catch (err) {
        console.debug("[facetime-voice] temp cleanup failed (raw)", err);
      }
      try {
        unlinkSync(tmpWav);
      } catch (err) {
        console.debug("[facetime-voice] temp cleanup failed (wav)", err);
      }
    }
  }
  /** Public so tools can re-push a greeting/line mid-call when remote can't hear. */
  async speakPcm(pcm) {
    if (this.closed) return;
    this.isPlaying = true;
    this.audioBuffer = [];
    try {
      await this.playToBlackHole(pcm);
      this.callInfo.lastGreetingOk = true;
    } catch (err) {
      this.callInfo.lastGreetingOk = false;
      throw err;
    } finally {
      await sleep(300);
      this.isPlaying = false;
      this.audioBuffer = [];
    }
  }
  setDeviceRoles(roles) {
    this.callInfo.micDevice = roles.micDevice;
    this.callInfo.outDevice = roles.outDevice;
    this.callInfo.multiOutputReady = roles.multiOutputReady;
  }
};
var FaceTimeVoiceProvider = class {
  name = "facetime";
  isAvailable() {
    return process.platform === "darwin";
  }
  /**
   * Initiate a FaceTime Audio call.
   *
   * @param contact — phone number, email, or Apple ID
   */
  async call(contact) {
    if (!this.isAvailable()) {
      throw new Error("FaceTime is only available on macOS");
    }
    const hasBlackHole = await checkBlackHole();
    if (!hasBlackHole) {
      throw new Error(
        "BlackHole 2ch virtual audio driver is not installed. Install it with: brew install blackhole-2ch"
      );
    }
    const session = new FaceTimeCallSession(contact);
    const savedInput = await getCurrentAudioDevice("input");
    const savedOutput = await getCurrentAudioDevice("output");
    session.setSavedDevices(savedInput, savedOutput);
    const roles = await resolveLiveDeviceRoles(savedOutput);
    session.setDeviceRoles(roles);
    if (!roles.multiOutputReady) {
      console.warn(
        `[facetime-voice] Multi-Output "${FT_MULTI_OUTPUT_DEVICE}" missing \u2014 inbound STT degraded.
${FACETIME_AUDIO_SETUP_HINT}`
      );
    }
    try {
      await setAudioDevice("input", roles.micDevice);
      await setAudioDevice("output", roles.outDevice).catch(
        (err) => console.debug(
          `[facetime-voice] set output ${roles.outDevice} failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      if (!roles.multiOutputReady) {
        await setAudioDevice("output", BLACKHOLE_DEVICE).catch(() => {
        });
        session.callInfo.outDevice = BLACKHOLE_DEVICE;
      }
      await execFileAsync("osascript", ["-e", "set volume input volume 100"], {
        timeout: 3e3
      }).catch(() => {
      });
      session.startSilenceStream();
      await sleep(400);
      await execFileAsync("osascript", ["-e", 'tell application "FaceTime" to activate'], {
        timeout: 5e3
      }).catch(
        (err) => console.debug(
          `[facetime-voice] FaceTime activate failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      await sleep(800);
      session.callInfo.state = "ringing";
      const urls = buildFaceTimeDialUrls(contact);
      let opened = false;
      for (const url of urls) {
        try {
          await execFileAsync("open", [url]);
          opened = true;
          break;
        } catch (err) {
          console.debug(
            `[facetime-voice] open ${url} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      if (!opened) {
        throw new Error(`Failed to open FaceTime for contact ${contact}`);
      }
      await sleep(2500);
      await this.clickFaceTimeCallButton();
    } catch (err) {
      session.close();
      const saved = session.getSavedDevices();
      if (saved.input) await setAudioDevice("input", saved.input).catch(() => {
      });
      if (saved.output) await setAudioDevice("output", saved.output).catch(() => {
      });
      throw err;
    }
    return session;
  }
  /**
   * On modern macOS, facetime-audio:// opens FaceTime on a confirmation sheet.
   * Click Call / FaceTime / Audio via Accessibility. Retries because the sheet
   * can lag a few seconds after the URL open (live stuck-on-sheet failure mode).
   */
  async clickFaceTimeCallButton() {
    const script = `
tell application "FaceTime" to activate
delay 0.4
tell application "System Events"
	tell process "FaceTime"
		set frontmost to true
		delay 0.2
		-- Direct description match (current Sequoia/Tahoe sheet)
		try
			click (first button of window 1 whose description is "Call")
			return "clicked-Call"
		end try
		try
			click (first button of window 1 whose description is "FaceTime")
			return "clicked-FaceTime"
		end try
		-- Walk UI tree for Call / FaceTime / Audio / FaceTime Audio
		try
			set elems to entire contents of window 1
			repeat with elem in elems
				try
					if class of elem is button then
						set d to description of elem as text
						if d is "Call" or d is "FaceTime" or d is "Audio" or d contains "FaceTime Audio" or d contains "Audio" then
							perform action "AXPress" of elem
							return "pressed-" & d
						end if
					end if
				end try
			end repeat
		end try
		-- Last resort: Return key on focused dial control
		try
			keystroke return
			return "return"
		end try
		return "no-button"
	end tell
end tell`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { stdout } = await execFileAsync("osascript", ["-e", script], {
          timeout: 1e4,
          encoding: "utf8"
        });
        const result = String(stdout ?? "").trim();
        if (result && !result.includes("no-button")) {
          console.log(`[facetime-voice] dial click: ${result} (attempt ${attempt + 1})`);
          return;
        }
        console.debug(`[facetime-voice] dial click miss: ${result || "empty"} (attempt ${attempt + 1})`);
      } catch (err) {
        console.debug(
          `[facetime-voice] dial click failed (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await sleep(1200);
    }
  }
  /**
   * End a FaceTime call and restore audio devices.
   */
  async hangup(session) {
    try {
      await execFileAsync(
        "osascript",
        [
          "-e",
          `
tell application "System Events"
	if exists process "FaceTime" then
		tell process "FaceTime"
			set frontmost to true
			try
				click (first button of window 1 whose description is "End")
				delay 0.5
				return "ended"
			end try
			try
				set elems to entire contents of window 1
				repeat with e in elems
					try
						if class of e is button and (description of e as text) is "End" then
							perform action "AXPress" of e
							return "ended-walk"
						end if
					end try
				end repeat
			end try
		end tell
	end if
end tell
return "no-end"
`
        ],
        { timeout: 8e3, encoding: "utf8" }
      );
    } catch {
    }
    try {
      await execFileAsync("osascript", ["-e", 'tell application "FaceTime" to quit'], {
        timeout: 5e3
      });
    } catch {
    }
    const saved = session.getSavedDevices();
    if (saved.input) {
      await setAudioDevice("input", saved.input).catch(
        (err) => console.debug(
          `[facetime-voice] restore input failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    if (saved.output) {
      await setAudioDevice("output", saved.output).catch(
        (err) => console.debug(
          `[facetime-voice] restore output failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    session.close();
  }
  /** VoiceProvider.connect — not used for FaceTime (use call() instead) */
  async connect(_config) {
    throw new Error("Use FaceTimeVoiceProvider.call() for FaceTime calls");
  }
};
async function checkBlackHole() {
  try {
    const { existsSync } = await import("fs");
    if (existsSync("/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver") || existsSync("/Library/Audio/Plug-Ins/HAL/BlackHole 2ch.driver")) {
      return true;
    }
  } catch (err) {
    console.debug("[facetime-voice] BlackHole driver fs-check failed", err);
  }
  try {
    const { stdout } = await execFileAsync("SwitchAudioSource", ["-a"], { timeout: 3e3 });
    if (stdout.includes("BlackHole")) return true;
  } catch (err) {
    console.debug("[facetime-voice] SwitchAudioSource probe failed", err);
  }
  try {
    const { stdout } = await execFileAsync("system_profiler", ["SPAudioDataType"], { timeout: 1e4 });
    return stdout.includes("BlackHole");
  } catch {
    return false;
  }
}
async function getCurrentAudioDevice(direction) {
  try {
    const flag = direction === "input" ? "-t input -c" : "-c";
    const { stdout } = await execFileAsync("SwitchAudioSource", flag.split(" "), { timeout: 3e3 });
    return stdout.trim() || null;
  } catch {
    try {
      const { stdout } = await execFileAsync("system_profiler", ["SPAudioDataType"], { timeout: 5e3 });
      const key = direction === "input" ? "Default Input Device: Yes" : "Default Output Device: Yes";
      const lines = stdout.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(key)) {
          for (let j = i - 1; j >= 0 && j > i - 6; j--) {
            const match = lines[j].match(/^\s{8}(\S.+):$/);
            if (match) return match[1];
          }
        }
      }
    } catch (err) {
      console.debug("[facetime-voice] system_profiler device parse failed", err);
    }
    return null;
  }
}
async function setAudioDevice(direction, device) {
  const args = direction === "input" ? ["-t", "input", "-s", device] : ["-s", device];
  try {
    await execFileAsync("SwitchAudioSource", args, { timeout: 3e3 });
    return;
  } catch (err) {
    await sleep(200);
    try {
      await execFileAsync("SwitchAudioSource", args, { timeout: 3e3 });
      return;
    } catch (err2) {
      throw new Error(
        `Failed to set ${direction} device to "${device}": ${err2 instanceof Error ? err2.message : String(err2)} (first: ${err instanceof Error ? err.message : String(err)})`
      );
    }
  }
}
async function listAudioDevices() {
  try {
    const { stdout } = await execFileAsync("SwitchAudioSource", ["-a"], { timeout: 3e3 });
    return parseSwitchAudioSourceList(stdout);
  } catch {
    return [];
  }
}
async function resolveLiveDeviceRoles(currentOutput) {
  const available = await listAudioDevices();
  return resolveFaceTimeDeviceRoles({
    availableDevices: available,
    currentOutput
  });
}
async function reassertFaceTimeDevices(roles) {
  await setAudioDevice("input", roles.micDevice).catch(() => {
  });
  await setAudioDevice("output", roles.outDevice).catch(() => {
  });
  await execFileAsync("osascript", ["-e", "set volume input volume 100"], {
    timeout: 3e3
  }).catch(() => {
  });
}
async function setupFaceTimeAudio() {
  const steps = [];
  const errors = [];
  if (process.platform !== "darwin") {
    errors.push("FaceTime Audio is only available on macOS");
    return { ok: false, steps, errors };
  }
  const hasBlackHole = await checkBlackHole();
  if (hasBlackHole) {
    steps.push("BlackHole 2ch audio driver: installed");
  } else {
    try {
      await execFileAsync("brew", ["install", "blackhole-2ch"], { timeout: 12e4 });
      steps.push("BlackHole 2ch audio driver: installed (just now)");
    } catch (err) {
      errors.push(`Failed to install BlackHole: ${err instanceof Error ? err.message : err}. Run: brew install blackhole-2ch`);
    }
  }
  try {
    await execFileAsync("which", ["SwitchAudioSource"], { timeout: 3e3 });
    steps.push("SwitchAudioSource: installed");
  } catch {
    try {
      await execFileAsync("brew", ["install", "switchaudio-osx"], { timeout: 6e4 });
      steps.push("SwitchAudioSource: installed (just now)");
    } catch (err) {
      errors.push(`Failed to install SwitchAudioSource: ${err instanceof Error ? err.message : err}. Run: brew install switchaudio-osx`);
    }
  }
  try {
    const devices = await listAudioDevices();
    const roles = resolveFaceTimeDeviceRoles({ availableDevices: devices });
    if (roles.multiOutputReady) {
      steps.push(`Multi-Output "${FT_MULTI_OUTPUT_DEVICE}": ready (two-way)`);
    } else {
      steps.push(
        `Multi-Output "${FT_MULTI_OUTPUT_DEVICE}": MISSING (inbound STT degraded).
${FACETIME_AUDIO_SETUP_HINT}`
      );
    }
  } catch (err) {
    steps.push(
      `Could not list audio devices: ${err instanceof Error ? err.message : err}`
    );
  }
  try {
    await execFileAsync("which", ["sox"], { timeout: 3e3 });
    steps.push("SoX audio tool: installed");
  } catch {
    errors.push("SoX not installed. Run: brew install sox");
  }
  try {
    const { stdout } = await execFileAsync("mdfind", ["kMDItemCFBundleIdentifier == 'com.apple.FaceTime'"], { timeout: 5e3 });
    if (stdout.trim()) {
      steps.push("FaceTime: available");
    } else {
      errors.push("FaceTime app not found on this Mac");
    }
  } catch {
    steps.push("FaceTime: assumed available");
  }
  return { ok: errors.length === 0, steps, errors };
}

export {
  FaceTimeCallSession,
  FaceTimeVoiceProvider,
  setAudioDevice,
  listAudioDevices,
  reassertFaceTimeDevices,
  setupFaceTimeAudio
};
