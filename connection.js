// getUserMedia cannot be aborted. Bound the UI wait and release late device results.
export function waitFor(promise, { signal, timeout = 0, label = '接続', onLate } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || new DOMException('接続をキャンセルしました。', 'AbortError'));
    Promise.resolve(promise).then(value => {
      if (settled) { onLate?.(value); return; }
      finish(resolve, value);
    }, error => finish(reject, error));
    if (signal?.aborted) abort();
    else {
      signal?.addEventListener('abort', abort, { once: true });
      if (timeout) timer = setTimeout(() => finish(reject, new DOMException(`${label}の応答がありません。再接続してください。`, 'TimeoutError')), timeout);
    }
  });
}
export function stopStream(stream) {
  stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
}
