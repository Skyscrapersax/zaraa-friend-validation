// src/voice/voice-path-metrics.ts
var metricSink = null;
function setVoicePathMetricSink(sink) {
  metricSink = sink;
}
function logVoicePathMetric(event, fields = {}) {
  const payload = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    component: "voice-path",
    event,
    ...fields
  };
  console.info(JSON.stringify(payload));
  if (metricSink) {
    try {
      metricSink(event, fields);
    } catch {
    }
  }
}

export {
  setVoicePathMetricSink,
  logVoicePathMetric
};
