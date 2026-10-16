// Capture PCM on the audio rendering thread; never play microphone audio.
class PCMRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.buffers = Array.from({ length: this.channels }, () => new Int16Array(1152));
    this.offset = 0;
    this.recording = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'start' || data === 'resume') this.recording = true;
      if (data === 'pause' || data === 'stop') {
        this.recording = false;
        this.flush();
        if (data === 'stop') this.port.postMessage({ type: 'stop' });
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const channels = this.buffers.map(buffer => buffer.slice(0, this.offset));
    this.port.postMessage({ type: 'pcm', channels }, channels.map(channel => channel.buffer));
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!this.recording || !input.length) return true;
    for (let frame = 0; frame < input[0].length; frame++) {
      for (let channel = 0; channel < this.channels; channel++) {
        const sample = Math.max(-1, Math.min(1, input[channel]?.[frame] || 0));
        this.buffers[channel][this.offset] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      }
      if (++this.offset === 1152) this.flush();
    }
    return true;
  }
}
registerProcessor('frame-pcm-recorder', PCMRecorder);
