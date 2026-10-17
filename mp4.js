import { waitFor } from './connection.js';

// Single-threaded core works on static GitHub Pages without COOP/COEP headers.
export async function convertToMp4(blob, { signal, channels, copyVideo = false, duration = 0, onProgress = () => {} } = {}) {
  let ffmpeg;
  const terminate = () => ffmpeg?.terminate();
  try {
    onProgress({ stage: 'loading', progress: 0 });
    const { FFmpeg } = await waitFor(import('./vendor/ffmpeg/ffmpeg/index.js'), { signal, timeout: 15000, label: 'MP4 変換モジュール' });
    if (signal?.aborted) throw signal.reason;
    ffmpeg = new FFmpeg();
    signal?.addEventListener('abort', terminate, { once: true });
    ffmpeg.on('progress', ({ time }) => onProgress({ stage: 'converting', progress: duration > 0 ? Math.min(.99, Math.max(0, time / 1000 / duration)) : 0 }));
    await waitFor(ffmpeg.load({
      coreURL: new URL('./vendor/ffmpeg/core/ffmpeg-core.js', import.meta.url).href,
      wasmURL: new URL('./vendor/ffmpeg/core/ffmpeg-core.wasm', import.meta.url).href
    }), { signal, timeout: 90000, label: 'MP4 変換エンジンの読み込み' });
    onProgress({ stage: 'converting', progress: 0 });
    await waitFor(ffmpeg.writeFile('input', new Uint8Array(await blob.arrayBuffer())), { signal, timeout: 30000, label: '動画の読み込み' });
    const video = copyVideo ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'];
    const code = await waitFor(ffmpeg.exec([
      '-i', 'input', '-map', '0:v:0', '-map', '0:a:0', ...video,
      '-c:a', 'aac', '-b:a', channels === 1 ? '128k' : '192k', '-ac', String(channels),
      '-movflags', '+faststart', '-threads', '1', '-y', 'output.mp4'
    ], 600000), { signal, timeout: 610000, label: 'MP4 変換' });
    if (code !== 0) throw new Error('MP4 への変換が完了しませんでした。元データは保存できます。');
    const bytes = await waitFor(ffmpeg.readFile('output.mp4'), { signal, timeout: 30000, label: 'MP4 の仕上げ' });
    if (String.fromCharCode(...bytes.slice(4, 8)) !== 'ftyp') throw new Error('MP4 ファイルを生成できませんでした。');
    onProgress({ stage: 'complete', progress: 1 });
    return new Blob([bytes], { type: 'video/mp4' });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new DOMException('変換をキャンセルしました。', 'AbortError');
    throw error instanceof Error ? error : new Error(String(error));
  } finally { signal?.removeEventListener('abort', terminate); terminate(); }
}
