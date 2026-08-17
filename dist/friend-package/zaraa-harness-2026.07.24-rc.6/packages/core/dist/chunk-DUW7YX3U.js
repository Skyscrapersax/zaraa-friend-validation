// src/voice/call-setup.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
async function autoSetupCalls(config) {
  const steps = [];
  const errors = [];
  const port = config.localPort ?? 3927;
  let fromNumber = config.fromNumber ?? "";
  let publicUrl = config.publicUrl ?? "";
  const greeting = config.greeting ?? "Hey, it's Zaraa.";
  let tunnelProcess;
  try {
    const valid = await validateTwilioCredentials(config.accountSid, config.authToken);
    if (!valid) {
      errors.push("Invalid Twilio credentials \u2014 check accountSid and authToken");
      return { ok: false, fromNumber, publicUrl, greeting, steps, errors };
    }
    steps.push("Twilio credentials verified");
  } catch (err) {
    errors.push(`Twilio auth check failed: ${err instanceof Error ? err.message : err}`);
    return { ok: false, fromNumber, publicUrl, greeting, steps, errors };
  }
  if (!fromNumber) {
    try {
      fromNumber = await provisionPhoneNumber(
        config.accountSid,
        config.authToken,
        config.country ?? "US"
      );
      steps.push(`Provisioned phone number: ${fromNumber}`);
    } catch (err) {
      errors.push(`Phone number provisioning failed: ${err instanceof Error ? err.message : err}`);
      return { ok: false, fromNumber, publicUrl, greeting, steps, errors };
    }
  } else {
    steps.push(`Using configured phone number: ${fromNumber}`);
  }
  if (!publicUrl) {
    try {
      const tunnel = await startTunnel(port);
      publicUrl = tunnel.url;
      tunnelProcess = tunnel.process;
      steps.push(`Tunnel started: ${publicUrl} \u2192 localhost:${port} (${tunnel.tool})`);
    } catch (err) {
      errors.push(`Tunnel setup failed: ${err instanceof Error ? err.message : err}`);
      return { ok: false, fromNumber, publicUrl, greeting, steps, errors };
    }
  } else {
    steps.push(`Using configured public URL: ${publicUrl}`);
  }
  const sttEngine = String(config.sttEngine ?? process.env.ZARAA_STT_ENGINE ?? "").toLowerCase();
  if (sttEngine === "xai-stt" || process.env.XAI_API_KEY) {
    steps.push("STT ready (xAI / Grok cloud)");
  } else {
    try {
      const sttOk = await checkWhisperFlow();
      if (sttOk) {
        steps.push("STT ready (WhisperFlow)");
      } else {
        errors.push(
          "No STT: set voice.stt.engine=xai-stt (Grok) or run WhisperFlow at localhost:8765"
        );
      }
    } catch (err) {
      console.debug("[call-setup] STT check failed:", err instanceof Error ? err.message : err);
      errors.push("STT check failed \u2014 configure xai-stt or start WhisperFlow");
    }
  }
  const ttsEngine = config.ttsEngine ?? "";
  if (ttsEngine === "xai-tts" || process.env.XAI_API_KEY) {
    steps.push("TTS ready (xAI / Grok cloud)");
  } else if (ttsEngine === "mlx-audio-local") {
    steps.push("TTS ready (MLX Audio local streaming)");
  } else if (ttsEngine === "voxtral-local") {
    steps.push("TTS ready (Voxtral local)");
  } else if (ttsEngine === "elevenlabs" || process.env.ELEVENLABS_API_KEY) {
    steps.push("TTS ready (ElevenLabs \u2014 accent & voice design supported)");
  } else if (ttsEngine === "openai-tts" || process.env.OPENAI_API_KEY) {
    steps.push("TTS ready (OpenAI). For accent support, set ELEVENLABS_API_KEY.");
  } else if (ttsEngine === "macos-say" || process.platform === "darwin") {
    steps.push("TTS ready (macOS Say fallback). For voice quality + accent, set ELEVENLABS_API_KEY.");
  } else {
    errors.push(
      "No TTS available \u2014 set XAI_API_KEY (Grok), ELEVENLABS_API_KEY, OPENAI_API_KEY, or run on macOS for Say fallback"
    );
  }
  const ok = errors.length === 0;
  return { ok, fromNumber, publicUrl, greeting, tunnelProcess, steps, errors };
}
async function validateTwilioCredentials(sid, token) {
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(1e4)
  });
  return res.ok;
}
async function provisionPhoneNumber(sid, token, country) {
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded"
  };
  const searchRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${country}/Local.json?VoiceEnabled=true&PageSize=1`,
    { headers, signal: AbortSignal.timeout(15e3) }
  );
  if (!searchRes.ok) {
    throw new Error(`Number search failed (${searchRes.status}): ${await searchRes.text()}`);
  }
  const searchData = await searchRes.json();
  if (!searchData.available_phone_numbers?.length) {
    throw new Error(`No voice-enabled numbers available in ${country}`);
  }
  const phoneNumber = searchData.available_phone_numbers[0].phone_number;
  const buyRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      headers,
      body: new URLSearchParams({ PhoneNumber: phoneNumber }).toString(),
      signal: AbortSignal.timeout(15e3)
    }
  );
  if (!buyRes.ok) {
    throw new Error(`Number purchase failed (${buyRes.status}): ${await buyRes.text()}`);
  }
  return phoneNumber;
}
async function startTunnel(port) {
  if (await isBinaryAvailable("ngrok")) {
    try {
      return await startNgrok(port);
    } catch (err) {
      console.debug("[call-setup] ngrok failed, trying cloudflared:", err instanceof Error ? err.message : err);
    }
  }
  if (await isBinaryAvailable("cloudflared")) {
    return startCloudflared(port);
  }
  throw new Error(
    "No tunnel tool found. Install one:\n  brew install ngrok     (then: ngrok config add-authtoken <token>)\n  brew install cloudflare/cloudflare/cloudflared"
  );
}
async function startNgrok(port) {
  return new Promise((resolve, reject) => {
    const proc = execFile("ngrok", ["http", String(port), "--log=stdout", "--log-format=json"], {
      timeout: 0
      // long-running
    });
    const timeout = setTimeout(() => {
      reject(new Error("ngrok failed to start within 15s"));
    }, 15e3);
    let resolved = false;
    proc.stdout?.on("data", (data) => {
      if (resolved) return;
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        try {
          const log = JSON.parse(line);
          if (log.url && typeof log.url === "string" && log.url.startsWith("https://")) {
            clearTimeout(timeout);
            resolved = true;
            resolve({ url: log.url, tool: "ngrok", process: proc });
            return;
          }
          if (log.msg && typeof log.msg === "string" && log.msg.includes("url=")) {
            const match = log.msg.match(/url=(https:\/\/[^\s]+)/);
            if (match) {
              clearTimeout(timeout);
              resolved = true;
              resolve({ url: match[1], tool: "ngrok", process: proc });
              return;
            }
          }
        } catch {
          const match = line.match(/(https:\/\/[a-z0-9-]+\.ngrok[a-z-]*\.[a-z]+)/i);
          if (match) {
            clearTimeout(timeout);
            resolved = true;
            resolve({ url: match[1], tool: "ngrok", process: proc });
            return;
          }
        }
      }
    });
    proc.stderr?.on("data", (data) => {
      if (!resolved && data.includes("ERR")) {
        clearTimeout(timeout);
        proc.kill();
        reject(new Error(`ngrok error: ${data.trim()}`));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });
    setTimeout(async () => {
      if (resolved) return;
      try {
        const res = await fetch("http://127.0.0.1:4040/api/tunnels", {
          signal: AbortSignal.timeout(3e3)
        });
        if (res.ok) {
          const data = await res.json();
          const httpsTunnel = data.tunnels.find((t) => t.proto === "https");
          if (httpsTunnel && !resolved) {
            clearTimeout(timeout);
            resolved = true;
            resolve({ url: httpsTunnel.public_url, tool: "ngrok", process: proc });
          }
        }
      } catch (err) {
        console.debug("[call-setup] ngrok API probe failed:", err instanceof Error ? err.message : err);
      }
    }, 3e3);
  });
}
async function startCloudflared(port) {
  return new Promise((resolve, reject) => {
    const proc = execFile("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      timeout: 0
    });
    const timeout = setTimeout(() => {
      reject(new Error("cloudflared failed to start within 20s"));
    }, 2e4);
    let resolved = false;
    proc.stderr?.on("data", (data) => {
      if (resolved) return;
      const match = data.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
      if (match) {
        clearTimeout(timeout);
        resolved = true;
        resolve({ url: match[1], tool: "cloudflared", process: proc });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}
async function isBinaryAvailable(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, [name], { timeout: 3e3 });
    return true;
  } catch (err) {
    console.debug("[call-setup] binary check failed for", name, ":", err instanceof Error ? err.message : err);
    return false;
  }
}
async function checkWhisperFlow() {
  try {
    const res = await fetch("http://localhost:8765/status", {
      signal: AbortSignal.timeout(3e3)
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === "ready";
  } catch (err) {
    console.debug("[call-setup] WhisperFlow status check failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export {
  autoSetupCalls
};
