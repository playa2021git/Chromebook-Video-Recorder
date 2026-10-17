import { waitFor } from './connection.js';

// A bounded queue of encoded chunks; completed writes are never retained in RAM.
// FileSystemWritableFileStream uses an on-disk temporary file, committed by close().
export class DirectFileSink {
  static async create(handle, options = {}) {
    const writable = await waitFor(handle.createWritable(), { timeout: 30000, label: '保存ファイルの準備', onLate: stream => stream.abort().catch(() => {}) });
    return new DirectFileSink(handle, writable, options);
  }
  constructor(handle, writable, { highWater = 4 * 1024 * 1024, lowWater = 1024 * 1024, batchSize = 256 * 1024, flushMs = 1000, writeTimeout = 30000, onProgress = () => {}, onBackpressure = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { handle, writable, highWater, lowWater, batchSize, writeTimeout, onProgress, onBackpressure, onError });
    this.pendingBytes = this.writtenBytes = this.maxPendingBytes = 0;
    this.batch = []; this.batchBytes = 0; this.queue = Promise.resolve(); this.closed = false; this.blocked = false;
    this.timer = setInterval(() => this.flush(), flushMs);
  }
  enqueue(blob) {
    if (this.closed || this.error || !blob.size) return;
    this.batch.push(blob); this.batchBytes += blob.size; this.pendingBytes += blob.size;
    this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingBytes);
    if (!this.blocked && this.pendingBytes >= this.highWater) { this.blocked = true; this.onBackpressure(true); }
    if (this.batchBytes >= this.batchSize) this.flush();
  }
  flush() {
    if (!this.batchBytes || this.error) return;
    const data = new Blob(this.batch), bytes = this.batchBytes;
    this.batch = []; this.batchBytes = 0;
    this.queue = this.queue.then(async () => {
      if (this.error) return;
      await waitFor(this.writable.write(data), { timeout: this.writeTimeout, label: 'ストレージ書き込み' });
      this.writtenBytes += bytes; this.onProgress(this.writtenBytes);
    }).catch(error => {
      if (!this.error) { this.error = error; this.pendingBytes -= this.batchBytes; this.batch = []; this.batchBytes = 0; this.onError(error); }
    }).finally(() => {
      this.pendingBytes -= bytes;
      if (this.blocked && this.pendingBytes <= this.lowWater) { this.blocked = false; this.onBackpressure(false); }
    });
  }
  async finish() {
    if (this.closed) throw new Error('保存処理は終了しています。');
    this.closed = true; clearInterval(this.timer); this.flush(); await this.queue;
    if (this.error) { await this.abort(); throw this.error; }
    try {
      await waitFor(this.writable.close(), { timeout: 30000, label: '保存の確定' });
      this.committed = true;
      return await waitFor(this.handle.getFile(), { timeout: 10000, label: '保存ファイルの確認' });
    } catch (error) { if (this.committed) error.committed = true; else await this.abort(); throw error; }
  }
  async abort() {
    this.closed = true; clearInterval(this.timer); this.batch = []; this.batchBytes = 0;
    // Ignore queued chunks after cancellation without converting to RAM recording.
    this.error ||= new DOMException('直接保存を中止しました。', 'AbortError');
    await waitFor(Promise.resolve().then(() => this.writable.abort()), { timeout: 3000, label: '保存の中止' }).catch(() => {});
  }
}
export function formatBytes(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
