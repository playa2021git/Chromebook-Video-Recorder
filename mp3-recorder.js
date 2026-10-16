// MediaRecorder-like adapter. PCM is encoded directly to MP3, entirely on device.
export class Mp3Recorder {
  static async create(context, input, channels) {
    const recorder = new Mp3Recorder();
    recorder.context = context;
    recorder.input = input;
    try {
      await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
      recorder.node = new AudioWorkletNode(context, 'frame-pcm-recorder', {
        channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { channels }
      });
      recorder.worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MP3 エンコーダーの読み込みがタイムアウトしました。')), 15000);
        recorder.worker.onmessage = ({ data }) => {
          if (data.type === 'ready' || data.type === 'error') {
            clearTimeout(timeout);
            if (data.type === 'ready') resolve(); else reject(new Error(data.message));
          }
        };
        recorder.worker.onerror = () => { clearTimeout(timeout); reject(new Error('MP3 エンコーダーを読み込めません。ページを再読み込みしてください。')); };
        recorder.worker.postMessage({ type: 'init', channels, sampleRate: context.sampleRate });
      });
      recorder.worker.onmessage = ({ data }) => {
        if (data.type === 'data') recorder.ondataavailable?.({ data: new Blob([data.buffer], { type: recorder.mimeType }) });
        if (data.type === 'done') recorder.complete();
        if (data.type === 'error') recorder.fail(new Error(data.message));
      };
      recorder.worker.onerror = () => recorder.fail(new Error('MP3 エンコード中にエラーが発生しました。'));
      recorder.node.onprocessorerror = () => recorder.fail(new Error('音声の取得中にエラーが発生しました。'));
      recorder.node.port.onmessage = ({ data }) => {
        if (data.type === 'pcm') recorder.worker.postMessage(data, data.channels.map(channel => channel.buffer));
        if (data.type === 'stop') recorder.worker.postMessage(data);
      };
      return recorder;
    } catch (error) { recorder.dispose(); throw error; }
  }
  constructor() { this.state = 'inactive'; this.mimeType = 'audio/mpeg'; this.completed = false; }
  start() {
    this.input.connect(this.node);
    // The worklet output is silence. Connecting it keeps processing active.
    this.node.connect(this.context.destination);
    this.state = 'recording'; this.node.port.postMessage('start');
  }
  pause() { this.state = 'paused'; this.node.port.postMessage('pause'); }
  resume() { this.state = 'recording'; this.node.port.postMessage('resume'); }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive'; this.node.port.postMessage('stop');
    this.stopTimeout = setTimeout(() => this.fail(new Error('MP3 の仕上げがタイムアウトしました。')), 30000);
  }
  fail(error) {
    if (this.completed) return;
    this.onerror?.({ error });
    this.complete();
  }
  complete() {
    if (this.completed) return;
    this.completed = true; this.state = 'inactive';
    this.dispose(); this.onstop?.();
  }
  dispose() {
    clearTimeout(this.stopTimeout);
    if (this.node) {
      try { this.input?.disconnect(this.node); } catch { /* Already disconnected. */ }
      this.node.disconnect(); this.node.port.close();
    }
    this.worker?.terminate();
  }
}
