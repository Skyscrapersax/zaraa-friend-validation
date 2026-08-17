class VoiceCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.port.onmessage = (event) => {
			if (event.data?.type === "flush") {
				this.port.postMessage({ type: "flushed" });
			}
		};
	}

	process(inputs) {
		const channel = inputs[0]?.[0];
		if (channel?.length) {
			const samples = new Float32Array(channel);
			this.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
		}
		return true;
	}
}

registerProcessor("voice-capture", VoiceCaptureProcessor);
