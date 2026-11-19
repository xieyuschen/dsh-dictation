// Durable audio is retained until deleteRecording() is explicitly called.
const copy = value => structuredClone(value);
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const recordingStates = new Set(['recording', 'stopped', 'interrupted']);
const chunkStates = new Set(['pending', 'transcribing', 'done', 'failed']);
function recording(input) {
  if (!input?.sessionId || typeof input.sessionId !== 'string') throw new TypeError('sessionId is required');
  return { ...copy(input), id: input.id ?? uuid(), sessionId: input.sessionId, createdAt: input.createdAt ?? Date.now(), state: 'recording', nextSeq: 0 };
}
function audioCopy(audio) {
  if (!(audio instanceof Uint8Array) && !(typeof Blob !== 'undefined' && audio instanceof Blob)) throw new TypeError('audio must be Uint8Array or Blob');
  if (!(audio.byteLength ?? audio.size)) throw new TypeError('audio must not be empty');
  return copy(audio);
}
function chunk(rec, audio) {
  const seq = rec.nextSeq;
  return { id: `${rec.id}:${seq}`, recordingId: rec.id, seq, audio: audioCopy(audio), status: 'pending', text: '', attempts: 0, error: null, nextAttemptAt: 0, delivery: 'pending' };
}
const noTail = rec => { const { tailAudio, ...metadata } = rec; return metadata; };
const noAudio = item => { const { audio, ...metadata } = item; return metadata; };
const clearTail = rec => { const { tailAudio, tailUpdatedAt, ...metadata } = rec; return metadata; };
function patchRecording(rec, patch) {
  if (!rec) throw new Error('Recording not found');
  if (['id', 'sessionId', 'createdAt', 'nextSeq'].some(key => key in patch) || ('state' in patch && !recordingStates.has(patch.state))) throw new TypeError('Invalid recording patch');
  const result = { ...rec, ...copy(patch) };
  if (result.tailAudio != null) result.tailAudio = audioCopy(result.tailAudio);
  return result;
}
function patchChunk(item, patch) {
  if (!item) throw new Error('Chunk not found');
  const allowed = ['status', 'text', 'attempts', 'error', 'nextAttemptAt', 'delivery'];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new TypeError('Invalid chunk patch');
  const next = { ...item, ...patch };
  if (!chunkStates.has(next.status) || !['pending', 'applied', 'conflict'].includes(next.delivery) || typeof next.text !== 'string' || !Number.isInteger(next.attempts) || next.attempts < 0 || !Number.isFinite(next.nextAttemptAt)) throw new TypeError('Invalid chunk state');
  return next;
}
class ObservableStore {
  listeners = new Set();
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(recordingId, type) {
    for (const listener of this.listeners) { try { listener({ recordingId, type }); } catch { /* A UI observer cannot break a committed write. */ } }
  }
}

export class MemoryStore extends ObservableStore {
  recordings = new Map();
  chunks = new Map();
  async createRecording(input) {
    const rec = recording(input);
    if (this.recordings.has(rec.id)) throw new Error('Recording already exists');
    this.recordings.set(rec.id, rec); this.notify(rec.id, 'recording'); return copy(rec);
  }
  async getRecording(id) { return copy(this.recordings.get(id)); }
  async getChunk(id) { return copy(this.chunks.get(id)); }
  async listRecordings({ sessionId, includeAudio = false } = {}) {
    return copy([...this.recordings.values()].filter(rec => !sessionId || rec.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt).map(rec => includeAudio ? rec : noTail(rec)));
  }
  async listChunks(recordingId, { includeAudio = true } = {}) {
    return copy([...this.chunks.values()].filter(item => item.recordingId === recordingId).sort((a, b) => a.seq - b.seq).map(item => includeAudio ? item : noAudio(item)));
  }
  async appendChunk(recordingId, audio) {
    const rec = this.recordings.get(recordingId);
    if (!rec || rec.state !== 'recording') throw new Error('Recording is not active');
    const item = chunk(rec, audio);
    this.chunks.set(item.id, item); this.recordings.set(rec.id, { ...clearTail(rec), nextSeq: rec.nextSeq + 1 });
    this.notify(rec.id, 'chunk'); return copy(item);
  }
  async updateRecording(id, patch) {
    const rec = patchRecording(this.recordings.get(id), patch); this.recordings.set(id, rec);
    this.notify(id, 'recording'); return copy(rec);
  }
  async updateChunk(id, patch) {
    const item = patchChunk(this.chunks.get(id), patch); this.chunks.set(id, item);
    this.notify(item.recordingId, 'chunk'); return copy(item);
  }
  async recover() {
    for (const [id, rec] of this.recordings) {
      let next = rec;
      if (rec.tailAudio) {
        const item = chunk(rec, rec.tailAudio);
        this.chunks.set(item.id, item); next = { ...clearTail(rec), nextSeq: rec.nextSeq + 1 };
      }
      if (next.state === 'recording') next = { ...next, state: 'interrupted' };
      this.recordings.set(id, next);
    }
    for (const [id, item] of this.chunks) if (item.status === 'transcribing') this.chunks.set(id, { ...item, status: 'pending', nextAttemptAt: 0 });
    this.notify(undefined, 'recovered');
  }
  async deleteRecording(id) {
    for (const [key, item] of this.chunks) if (item.recordingId === id) this.chunks.delete(key);
    this.recordings.delete(id); this.notify(id, 'deleted');
  }
  close() { this.listeners.clear(); }
}

const asBlob = audio => audio instanceof Blob ? audio : new Blob([audio], { type: 'audio/wav' });
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
});

export class IndexedDbStore extends ObservableStore {
  constructor({ name = 'dsh-dictation', indexedDB = globalThis.indexedDB } = {}) {
    super(); this.name = name; this.indexedDB = indexedDB; this.database = null;
  }
  async open() {
    if (!this.indexedDB) throw new Error('IndexedDB unavailable; durable dictation cannot start');
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const req = this.indexedDB.open(this.name, 1);
        let blocked = false;
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('recordings', { keyPath: 'id' });
          const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
          chunks.createIndex('recordingId', 'recordingId');
          chunks.createIndex('sequence', ['recordingId', 'seq'], { unique: true });
        };
        req.onsuccess = () => {
          if (blocked) { req.result.close(); return; }
          req.result.onversionchange = () => { req.result.close(); this.database = null; };
          resolve(req.result);
        };
        req.onerror = () => { this.database = null; reject(req.error ?? new Error('IndexedDB open failed')); };
        req.onblocked = () => { blocked = true; this.database = null; reject(new Error('IndexedDB upgrade blocked by another tab')); };
      });
    }
    return this.database;
  }
  async run(names, mode, action) {
    const db = await this.open();
    const tx = db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => {}; // onabort owns the transaction failure.
    });
    // Attach immediately: a quota abort may precede completion of action().
    done.catch(() => {});
    try { const result = await action(tx); await done; return result; }
    catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
  async createRecording(input) {
    const rec = recording(input);
    if (rec.tailAudio) rec.tailAudio = asBlob(audioCopy(rec.tailAudio));
    await this.run(['recordings'], 'readwrite', tx => requestResult(tx.objectStore('recordings').add(rec)));
    this.notify(rec.id, 'recording'); return copy(rec);
  }
  getRecording(id) { return this.run(['recordings'], 'readonly', tx => requestResult(tx.objectStore('recordings').get(id))); }
  getChunk(id) { return this.run(['chunks'], 'readonly', tx => requestResult(tx.objectStore('chunks').get(id))); }
  async listRecordings({ sessionId, includeAudio = false } = {}) {
    const rows = await this.run(['recordings'], 'readonly', tx => requestResult(tx.objectStore('recordings').getAll()));
    return rows.filter(rec => !sessionId || rec.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt).map(rec => includeAudio ? rec : noTail(rec));
  }
  async listChunks(recordingId, { includeAudio = true } = {}) {
    const rows = await this.run(['chunks'], 'readonly', tx => requestResult(tx.objectStore('chunks').index('recordingId').getAll(recordingId)));
    return rows.sort((a, b) => a.seq - b.seq).map(item => includeAudio ? item : noAudio(item));
  }
  async appendChunk(recordingId, audio) {
    // Copy before opening the transaction; no asynchronous encoding inside IDB.
    const savedAudio = asBlob(audioCopy(audio));
    const item = await this.run(['recordings', 'chunks'], 'readwrite', async tx => {
      const recordings = tx.objectStore('recordings');
      const rec = await requestResult(recordings.get(recordingId));
      if (!rec || rec.state !== 'recording') throw new Error('Recording is not active');
      const value = chunk(rec, savedAudio);
      await requestResult(tx.objectStore('chunks').add(value));
      await requestResult(recordings.put({ ...clearTail(rec), nextSeq: rec.nextSeq + 1 }));
      return value;
    });
    this.notify(recordingId, 'chunk'); return item;
  }
  async updateRecording(id, patch) {
    const result = await this.run(['recordings'], 'readwrite', async tx => {
      const store = tx.objectStore('recordings');
      const value = patchRecording(await requestResult(store.get(id)), patch);
      if (value.tailAudio) value.tailAudio = asBlob(value.tailAudio);
      await requestResult(store.put(value)); return value;
    });
    this.notify(id, 'recording'); return result;
  }
  async updateChunk(id, patch) {
    const result = await this.run(['chunks'], 'readwrite', async tx => {
      const store = tx.objectStore('chunks');
      const value = patchChunk(await requestResult(store.get(id)), patch);
      await requestResult(store.put(value)); return value;
    });
    this.notify(result.recordingId, 'chunk'); return result;
  }
  async recover() {
    await this.run(['recordings', 'chunks'], 'readwrite', async tx => {
      const recordings = tx.objectStore('recordings'), chunks = tx.objectStore('chunks');
      const rows = await requestResult(recordings.getAll());
      for (const rec of rows) {
        let next = rec;
        if (rec.tailAudio) {
          await requestResult(chunks.add(chunk(rec, rec.tailAudio)));
          next = { ...clearTail(rec), nextSeq: rec.nextSeq + 1 };
        }
        if (next.state === 'recording') next = { ...next, state: 'interrupted' };
        await requestResult(recordings.put(next));
      }
      const items = await requestResult(chunks.getAll());
      for (const item of items) if (item.status === 'transcribing') await requestResult(chunks.put({ ...item, status: 'pending', nextAttemptAt: 0 }));
    });
    this.notify(undefined, 'recovered');
  }
  async deleteRecording(id) {
    await this.run(['recordings', 'chunks'], 'readwrite', async tx => {
      const chunks = tx.objectStore('chunks');
      const keys = await requestResult(chunks.index('recordingId').getAllKeys(id));
      for (const key of keys) await requestResult(chunks.delete(key));
      await requestResult(tx.objectStore('recordings').delete(id));
    });
    this.notify(id, 'deleted');
  }
  async close() { const db = await this.database; db?.close(); this.database = null; this.listeners.clear(); }
}
