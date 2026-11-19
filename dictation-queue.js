// UI-independent sequential worker. Unsubscribing a view does not stop this service.
export function isTransientError(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const status = error?.status ?? error?.statusCode;
  if (status != null) return [408, 425, 429].includes(status) || status >= 500;
  return /network|fetch failed|timed? out|timeout|busy|not ready|HTTP (408|425|429|5\d\d)|ECONN|ENET|EAI_AGAIN|socket|connection/i.test(error?.message ?? String(error));
}
const errorText = error => String(error?.message ?? error).slice(0, 2000);

export class DictationQueue {
  constructor({ store, transcribe, onStorageError = () => {}, maxAttempts = 3, retryBaseMs = 1000, retryMaxMs = 15000, isTransient = isTransientError, now = Date.now }) {
    if (!store || typeof transcribe !== 'function') throw new TypeError('store and transcribe are required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || retryBaseMs < 0 || retryMaxMs < retryBaseMs) throw new TypeError('Invalid retry policy');
    Object.assign(this, { store, transcribe, onStorageError, maxAttempts, retryBaseMs, retryMaxMs, isTransient, now });
    this.active = false; this.initialized = false; this.worker = null; this.starting = null;
    this.generation = 0; this.current = null; this.wake = null; this.dirty = false;
    this.listeners = new Set(); this.lastStorageError = null;
    this.unsubscribeStore = store.subscribe(event => { this.notify(event); this.kick(); });
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(event) { for (const listener of this.listeners) { try { listener(event); } catch {} } }
  storageFailed(error) {
    this.lastStorageError = error; this.active = false; this.initialized = false; this.current?.controller.abort(error); this.wake?.();
    try { this.onStorageError(error); } catch {}
    this.notify({ type: 'storage-error', error });
  }
  async durable(operation) {
    try { return await operation(); } catch (error) { this.storageFailed(error); throw error; }
  }
  async start() {
    if (this.active) return this;
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    this.starting = (async () => {
      if (!this.initialized) { await this.durable(() => this.store.recover()); this.initialized = true; }
      if (this.generation === generation) { this.active = true; this.lastStorageError = null; this.kick(); }
      return this;
    })();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async enqueue(recordingId, audio) {
    const item = await this.durable(() => this.store.appendChunk(recordingId, audio));
    this.kick(); return item;
  }
  async finishRecording(recordingId) {
    const rec = await this.durable(() => this.store.updateRecording(recordingId, { state: 'stopped' }));
    this.kick(); return rec;
  }
  async retry(chunkId) {
    const item = await this.durable(() => this.store.getChunk(chunkId));
    if (!item || item.status !== 'failed') throw new Error('Only a failed chunk can be retried');
    await this.durable(() => this.store.updateChunk(chunkId, { status: 'pending', attempts: 0, error: null, nextAttemptAt: 0 }));
    this.kick();
  }
  async stop() {
    ++this.generation; this.active = false; this.dirty = false;
    this.current?.controller.abort(new DOMException('Dictation queue paused', 'AbortError'));
    this.wake?.();
    if (this.starting) await this.starting.catch(() => {});
    if (this.worker) await this.worker;
  }
  abort() { return this.stop(); }
  async close() { await this.stop(); this.unsubscribeStore(); this.listeners.clear(); }
  async waitForIdle() { while (this.worker) await this.worker; }
  kick() {
    if (!this.active) return;
    this.dirty = true; this.wake?.();
    if (this.worker) return;
    // Assign before running: synchronous notifications cannot start another pump.
    this.worker = Promise.resolve().then(() => this.drain()).catch(error => this.storageFailed(error)).finally(() => {
      this.worker = null;
      if (this.active && this.dirty) this.kick();
    });
  }
  async select() {
    const recordings = await this.store.listRecordings();
    let delay = Infinity;
    for (const recording of recordings) {
      const items = await this.store.listChunks(recording.id, { includeAudio: false });
      // A failed predecessor blocks later chunks in this recording, never skips text.
      const head = items.find(item => item.status !== 'done');
      if (!head || head.status !== 'pending') continue;
      const remaining = (head.nextAttemptAt ?? 0) - this.now();
      if (remaining > 0) { delay = Math.min(delay, remaining); continue; }
      return { item: await this.store.getChunk(head.id), recording, delay: 0 };
    }
    return { delay };
  }
  async pause(delay) {
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); if (this.wake === finish) this.wake = null; resolve(); };
      const timer = setTimeout(finish, Math.max(0, delay)); this.wake = finish;
      if (!this.active || this.dirty) finish();
    });
  }
  async drain() {
    while (this.active) {
      this.dirty = false;
      const selected = await this.select();
      if (!this.active) break;
      if (!selected.item) {
        if (Number.isFinite(selected.delay)) { await this.pause(selected.delay); continue; }
        if (this.dirty) continue;
        break;
      }
      await this.recognize(selected.item, selected.recording);
    }
  }
  async recognize(item, recording) {
    const controller = new AbortController();
    this.current = { id: item.id, recordingId: item.recordingId, controller };
    try {
      await this.store.updateChunk(item.id, { status: 'transcribing', attempts: item.attempts + 1, error: null, nextAttemptAt: 0 });
    } catch (error) { this.current = null; throw error; }
    let result, failure;
    try {
      controller.signal.throwIfAborted();
      if (!this.active) throw new DOMException('Dictation queue paused', 'AbortError');
      result = await this.transcribe(item.audio, controller.signal, { ...item, attempts: item.attempts + 1 }, recording);
      controller.signal.throwIfAborted();
      const text = typeof result === 'string' ? result : result?.text;
      if (typeof text !== 'string') throw new Error('ASR response is missing transcription text');
      result = text;
    } catch (error) { failure = error; }
    try {
      if (controller.signal.aborted || !this.active) {
        await this.store.updateChunk(item.id, { status: 'pending', nextAttemptAt: 0, error: null });
      } else if (!failure) {
        await this.store.updateChunk(item.id, { status: 'done', text: result, error: null, nextAttemptAt: 0 });
      } else {
        const retry = item.attempts + 1 < this.maxAttempts && this.isTransient(failure);
        const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(item.attempts, 30));
        await this.store.updateChunk(item.id, { status: retry ? 'pending' : 'failed', error: errorText(failure), nextAttemptAt: retry ? this.now() + delay : 0 });
      }
    } finally { this.current = null; }
  }
}
