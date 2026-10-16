/* lamejs 1.2.1 (LGPL-3.0). Source and license: vendor/lamejs/ */
importScripts('./vendor/lamejs/lame.min.js');
let encoder;
function send(bytes) {
  if (!bytes.length) return;
  const buffer = new Uint8Array(bytes);
  self.postMessage({ type: 'data', buffer }, [buffer.buffer]);
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      encoder = new lamejs.Mp3Encoder(data.channels, data.sampleRate, data.channels === 2 ? 192 : 128);
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'pcm') {
      send(encoder.encodeBuffer(data.channels[0], data.channels[1]));
    } else if (data.type === 'stop') {
      send(encoder.flush());
      self.postMessage({ type: 'done' });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
