// src/voice/facetime-audio-graph.ts
var BLACKHOLE_DEVICE = "BlackHole 2ch";
var FT_MULTI_OUTPUT_DEVICE = "Zaraa FT Out";
var FACETIME_AUDIO_SETUP_HINT = [
  "Create Multi-Output device once:",
  "  1. Open Audio MIDI Setup (Spotlight \u2192 Audio MIDI Setup)",
  "  2. Bottom-left + \u2192 Create Multi-Output Device",
  "  3. Check: your speakers (e.g. Mac mini Speakers) AND BlackHole 2ch",
  "  4. Rename the device to exactly: Zaraa FT Out",
  "  5. Prefer speakers as master clock if given a choice",
  "Then re-run FaceTime setup / restart Zaraa."
].join("\n");
function buildFaceTimeDialUrls(contact) {
  const cleaned = contact.replace(/"/g, "").trim();
  if (!cleaned) return [];
  const encoded = encodeURIComponent(cleaned);
  const digits = cleaned.replace(/^\+/, "");
  const urls = [
    `facetime-audio://${encoded}`,
    `facetime-audio://${digits}`,
    `facetime://${digits}`
  ];
  return [...new Set(urls)];
}
function resolveFaceTimeDeviceRoles(opts) {
  const names = opts.availableDevices.map((d) => d.trim()).filter(Boolean);
  const hasBlackHole = names.some((n) => /blackhole/i.test(n));
  const multi = names.find((n) => n === FT_MULTI_OUTPUT_DEVICE) || names.find((n) => /zaraa\s*ft\s*out/i.test(n));
  const multiOutputReady = Boolean(multi);
  return {
    micDevice: hasBlackHole ? names.find((n) => n === BLACKHOLE_DEVICE) || names.find((n) => /blackhole.*2/i.test(n)) || BLACKHOLE_DEVICE : BLACKHOLE_DEVICE,
    outDevice: multi || opts.currentOutput || "Mac mini Speakers",
    multiOutputReady
  };
}
function measurePcm16Energy(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n <= 0) return { rms: 0, peak: 0, activeFrac: 0 };
  let sumSq = 0;
  let peak = 0;
  let active = 0;
  const thr = 500;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    const a = Math.abs(s);
    sumSq += s * s;
    if (a > peak) peak = a;
    if (a > thr) active++;
  }
  return {
    rms: Math.sqrt(sumSq / n),
    peak,
    activeFrac: active / n
  };
}
function isSpeechLikePcm16(pcm, opts) {
  const minRms = opts?.minRms ?? 800;
  const minActiveFrac = opts?.minActiveFrac ?? 0.02;
  const { rms, activeFrac } = measurePcm16Energy(pcm);
  return rms >= minRms || activeFrac >= minActiveFrac;
}
function parseSwitchAudioSourceList(stdout) {
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export {
  BLACKHOLE_DEVICE,
  FT_MULTI_OUTPUT_DEVICE,
  FACETIME_AUDIO_SETUP_HINT,
  buildFaceTimeDialUrls,
  resolveFaceTimeDeviceRoles,
  isSpeechLikePcm16,
  parseSwitchAudioSourceList
};
