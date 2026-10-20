// Screen Wake Lock is available only while the page is visible. It cannot
// override a closed lid, manual sleep, or an operating-system shutdown.
export class RecordingWakeLock {
  constructor({ wakeLock = globalThis.navigator?.wakeLock, document = globalThis.document, onStatus = () => {} } = {}) {
    this.api = wakeLock; this.document = document; this.onStatus = onStatus;
    this.active = false; this.lock = null; this.pending = null; this.generation = 0;
    document.addEventListener('visibilitychange', () => {
      if (!this.active) return;
      if (document.visibilityState === 'visible') this.acquire();
      else this.report('hidden');
    });
  }
  report(state) { this.onStatus(state); }
  start() { this.active = true; return this.acquire(); }
  async acquire() {
    if (!this.active) return;
    if (!this.api?.request) { this.report('unsupported'); return; }
    if (this.document.visibilityState !== 'visible') { this.report('hidden'); return; }
    if (this.lock && !this.lock.released) { this.report('held'); return; }
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.report('requesting');
    const task = (async () => {
      try {
        const lock = await this.api.request('screen');
        if (!this.active || generation !== this.generation) { await lock.release(); return; }
        this.lock = lock;
        lock.addEventListener('release', () => {
          if (this.lock !== lock) return;
          this.lock = null;
          if (this.active) this.report(this.document.visibilityState === 'visible' ? 'released' : 'hidden');
        });
        this.report(lock.released ? 'released' : 'held');
      } catch {
        if (this.active && generation === this.generation) this.report('failed');
      }
    })();
    this.pending = task;
    try { await task; } finally { if (this.pending === task) this.pending = null; }
    // A new recording may have started while the previous request was pending.
    if (this.active && generation !== this.generation) return this.acquire();
  }
  stop() {
    this.active = false; this.generation++;
    const lock = this.lock; this.lock = null;
    if (lock) Promise.resolve(lock.release()).catch(() => {});
    this.report('idle');
  }
}
