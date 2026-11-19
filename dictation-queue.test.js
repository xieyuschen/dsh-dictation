import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, IndexedDbStore } from './dictation-store.js';
import { DictationQueue, isTransientError } from './dictation-queue.js';

const audio = n => new Uint8Array([82, 73, 70, 70, n]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 1000; i++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Condition did not become true');
}
async function setup(transcribe, options = {}) {
  const store = options.store ?? new MemoryStore();
  const queue = new DictationQueue({ store, transcribe, retryBaseMs: 2, retryMaxMs: 4, ...options });
  await queue.start();
  const recording = await store.createRecording({ id: 'rec', sessionId: 'conversation', selection: { language: 'zh' } });
  return { store, queue, recording };
}

test('audio is committed before ASR, serial order, metadata and audio retained', async () => {
  let active = 0, maximum = 0; const seen = [];
  const { store, queue } = await setup(async (bytes, signal, item, rec) => {
    active++; maximum = Math.max(maximum, active);
    assert.equal((await store.getChunk(item.id)).status, 'transcribing');
    assert.equal(rec.selection.language, 'zh'); assert.equal(signal.aborted, false);
    await new Promise(resolve => setImmediate(resolve));
    seen.push(bytes[4]); active--; return { text: `text-${bytes[4]}` };
  });
  const original = audio(0);
  await queue.enqueue('rec', original); original[4] = 99;
  await Promise.all(Array.from({ length: 20 }, (_, i) => queue.enqueue('rec', audio(i + 1))));
  await queue.finishRecording('rec'); await queue.waitForIdle();
  assert.equal(maximum, 1); assert.deepEqual(seen, Array.from({ length: 21 }, (_, i) => i));
  const chunks = await store.listChunks('rec');
  assert.ok(chunks.every(item => item.status === 'done' && item.audio.byteLength === 5));
  assert.equal(chunks[0].text, 'text-0'); assert.equal((await store.getRecording('rec')).state, 'stopped');
  await queue.close();
});

test('bounded transient exponential retries retain audio then fail, manual retry unblocks successors', async () => {
  let succeed = false; const calls = [];
  const { store, queue } = await setup(async (bytes, signal, item) => {
    calls.push(item.seq); if (!succeed) throw new Error('GPU ASR is busy; retry shortly'); return 'ok';
  });
  await queue.enqueue('rec', audio(1)); await queue.enqueue('rec', audio(2));
  await queue.waitForIdle();
  let chunks = await store.listChunks('rec');
  assert.deepEqual(calls, [0, 0, 0]); assert.equal(chunks[0].status, 'failed');
  assert.equal(chunks[0].attempts, 3); assert.equal(chunks[1].status, 'pending');
  assert.deepEqual(chunks[0].audio, audio(1));
  succeed = true; await queue.retry(chunks[0].id); await queue.waitForIdle();
  chunks = await store.listChunks('rec'); assert.ok(chunks.every(item => item.status === 'done'));
  assert.deepEqual(calls, [0, 0, 0, 0, 1]); await queue.close();
});

test('permanent failure does not retry, other recording can progress without out-of-order text', async () => {
  const { store, queue } = await setup(async (bytes, signal, item) => {
    if (item.recordingId === 'rec') throw new Error('ASR returned invalid JSON'); return 'second';
  });
  await store.createRecording({ id: 'other', sessionId: 'different' });
  await queue.enqueue('rec', audio(1)); await queue.enqueue('rec', audio(2)); await queue.enqueue('other', audio(3));
  await queue.waitForIdle();
  const first = await store.listChunks('rec');
  assert.equal(first[0].attempts, 1); assert.equal(first[0].status, 'failed'); assert.equal(first[1].attempts, 0);
  assert.equal((await store.listChunks('other'))[0].status, 'done'); await queue.close();
});

test('stop aborts request, retains pending audio, restart runs exactly once', async () => {
  const began = deferred(); let calls = 0;
  const { store, queue } = await setup(async (bytes, signal) => {
    calls++; if (calls > 1) return 'resumed';
    began.resolve(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await queue.enqueue('rec', audio(7)); await began.promise; await queue.stop();
  let item = (await store.listChunks('rec'))[0];
  assert.equal(item.status, 'pending'); assert.deepEqual(item.audio, audio(7));
  await queue.start(); await queue.waitForIdle();
  item = (await store.listChunks('rec'))[0]; assert.equal(item.text, 'resumed'); assert.equal(calls, 2);
  assert.equal((await store.getRecording('rec')).state, 'recording'); await queue.close();
});

test('recovery reclaims in-flight, preserves done results and isolates conversation enumeration', async () => {
  const store = new MemoryStore();
  await store.createRecording({ id: 'saved', sessionId: 'a' });
  const a = await store.appendChunk('saved', audio(1)), b = await store.appendChunk('saved', audio(2));
  await store.updateChunk(a.id, { status: 'done', text: 'already done', delivery: 'applied' });
  await store.updateChunk(b.id, { status: 'transcribing', attempts: 1 });
  await store.createRecording({ id: 'other', sessionId: 'b' });
  const seen = []; const queue = new DictationQueue({ store, transcribe: async bytes => { seen.push(bytes[4]); return 'recovered'; } });
  await queue.start(); await queue.waitForIdle();
  assert.deepEqual(seen, [2]); assert.equal((await store.getRecording('saved')).state, 'interrupted');
  assert.equal((await store.getChunk(a.id)).delivery, 'applied');
  assert.equal((await store.listRecordings({ sessionId: 'a' })).length, 1); await queue.close();
});

test('checkpoint tail promotes atomically once and append clears old checkpoint', async () => {
  const store = new MemoryStore(); await store.createRecording({ id: 'tail', sessionId: 'a' });
  await store.updateRecording('tail', { tailAudio: audio(4), tailUpdatedAt: 123 });
  const first = await store.appendChunk('tail', audio(5));
  assert.equal(first.seq, 0); assert.equal((await store.getRecording('tail')).tailAudio, undefined);
  await store.updateRecording('tail', { tailAudio: audio(6), tailUpdatedAt: 456 });
  assert.equal((await store.listRecordings())[0].tailAudio, undefined);
  await store.recover(); await store.recover();
  const chunks = await store.listChunks('tail');
  assert.deepEqual(chunks.map(item => item.seq), [0, 1]); assert.deepEqual(chunks[1].audio, audio(6));
  const rec = await store.getRecording('tail'); assert.equal(rec.nextSeq, 2); assert.equal(rec.tailAudio, undefined);
  assert.equal(rec.tailUpdatedAt, undefined); assert.equal(rec.state, 'interrupted');
});

test('metadata reads omit audio, snapshots cannot mutate saved bytes, explicit deletion removes both stores', async () => {
  const store = new MemoryStore(); await store.createRecording({ id: 'r', sessionId: 'a' });
  const item = await store.appendChunk('r', audio(9));
  item.audio[0] = 0; assert.equal((await store.getChunk(item.id)).audio[0], 82);
  assert.equal((await store.listChunks('r', { includeAudio: false }))[0].audio, undefined);
  await store.updateChunk(item.id, { status: 'done', text: 'retained', delivery: 'conflict' });
  await store.recover(); assert.ok((await store.getChunk(item.id)).audio);
  await store.deleteRecording('r'); assert.equal(await store.getRecording('r'), undefined);
  assert.deepEqual(await store.listChunks('r'), []);
});

test('enqueue storage rejection stops service, surfaces callback, never recognizes unsaved audio', async () => {
  class QuotaStore extends MemoryStore { async appendChunk() { throw new DOMException('Full', 'QuotaExceededError'); } }
  const failures = []; let calls = 0;
  const { store, queue } = await setup(async () => { calls++; return 'no'; }, { store: new QuotaStore(), onStorageError: error => failures.push(error) });
  const bytes = audio(8); await assert.rejects(queue.enqueue('rec', bytes), { name: 'QuotaExceededError' });
  await queue.waitForIdle(); assert.equal(calls, 0); assert.equal(queue.active, false); assert.equal(failures.length, 1);
  assert.equal(bytes[4], 8); assert.deepEqual(await store.listChunks('rec'), []); await queue.close();
});

test('failure persisting transcript stops service; recovery retains audio and can retry', async () => {
  class FailingStore extends MemoryStore {
    fail = true;
    async updateChunk(id, patch) { if (this.fail && patch.status === 'done') throw new Error('Disk unavailable'); return super.updateChunk(id, patch); }
  }
  const store = new FailingStore(); const failures = [];
  const { queue } = await setup(async () => 'first result', { store, onStorageError: error => failures.push(error) });
  await queue.enqueue('rec', audio(3)); await queue.waitForIdle();
  assert.equal(queue.active, false); assert.equal(failures.length, 1);
  assert.equal((await store.listChunks('rec'))[0].status, 'transcribing'); await queue.close();
  store.fail = false;
  const recovered = new DictationQueue({ store, transcribe: async () => 'second result' });
  await recovered.start(); await recovered.waitForIdle();
  const item = (await store.listChunks('rec'))[0]; assert.equal(item.text, 'second result'); assert.deepEqual(item.audio, audio(3));
  await recovered.close();
});

test('same service can recover uncertain in-flight state after storage failure', async () => {
  class TemporaryStore extends MemoryStore {
    broken = true;
    async updateChunk(id, patch) { if (this.broken && patch.status === 'done') throw new Error('Temporary disk failure'); return super.updateChunk(id, patch); }
  }
  const store = new TemporaryStore();
  const { queue } = await setup(async () => 'recovered same service', { store });
  await queue.enqueue('rec', audio(5)); await queue.waitForIdle();
  assert.equal(queue.active, false); assert.equal((await store.listChunks('rec'))[0].status, 'transcribing');
  store.broken = false; await queue.start(); await queue.waitForIdle();
  assert.equal((await store.listChunks('rec'))[0].status, 'done');
  assert.equal((await store.getRecording('rec')).state, 'interrupted'); await queue.close();
});

test('view unsubscribe does not stop service, observer errors do not corrupt persisted results', async () => {
  const ready = deferred(); const { store, queue } = await setup(async () => { await ready.promise; return 'done'; });
  let notices = 0; const unsubscribe = queue.subscribe(() => { notices++; });
  queue.subscribe(() => { throw new Error('UI observer broke'); });
  await queue.enqueue('rec', audio(1)); unsubscribe(); const before = notices;
  ready.resolve(); await queue.waitForIdle();
  assert.equal(notices, before); assert.equal((await store.listChunks('rec'))[0].text, 'done'); await queue.close();
});

test('idle pump race: enqueue during stale empty snapshot is not stranded', async () => {
  class SnapshotStore extends MemoryStore {
    gate = null; entered = null;
    async listRecordings(...args) {
      const rows = await super.listRecordings(...args);
      if (this.gate) { const gate = this.gate; this.gate = null; this.entered.resolve(); await gate.promise; }
      return rows;
    }
  }
  const store = new SnapshotStore(); const gate = deferred(), entered = deferred();
  store.gate = gate; store.entered = entered;
  const queue = new DictationQueue({ store, transcribe: async () => 'not stranded' });
  await queue.start(); await entered.promise;
  await store.createRecording({ id: 'r', sessionId: 'a' }); await queue.enqueue('r', audio(1));
  gate.resolve(); await queue.waitForIdle();
  assert.equal((await store.listChunks('r'))[0].text, 'not stranded'); await queue.close();
});

test('stop during retry delay is prompt and restart completes saved chunk', async () => {
  let fail = true; const { store, queue } = await setup(async () => { if (fail) throw new Error('network timeout'); return 'back'; }, { retryBaseMs: 60000, retryMaxMs: 60000 });
  await queue.enqueue('rec', audio(2)); await until(async () => (await store.listChunks('rec'))[0]?.nextAttemptAt > 0);
  await queue.stop(); assert.equal((await store.listChunks('rec'))[0].status, 'pending');
  fail = false; const item = (await store.listChunks('rec'))[0]; await store.updateChunk(item.id, { nextAttemptAt: 0 });
  await queue.start(); await queue.waitForIdle(); assert.equal((await store.getChunk(item.id)).text, 'back'); await queue.close();
});

test('IndexedDB missing fails loudly instead of falling back to volatile memory', async () => {
  const store = new IndexedDbStore({ indexedDB: null }); const failures = [];
  const queue = new DictationQueue({ store, transcribe: async () => 'no', onStorageError: error => failures.push(error) });
  await assert.rejects(queue.start(), /IndexedDB unavailable/); assert.equal(failures.length, 1); assert.equal(queue.active, false); await queue.close();
});

// Minimal asynchronous IDB contract fake: transactions commit only on completion,
// abort rolls back all stores, request handlers run before transaction completion.
function fakeIndexedDB() {
  const databases = new Map();
  const api = { failPutStore: null, open(name) {
    const req = {};
    setImmediate(() => {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const stores = databases.get(name);
      req.result = {
        close() {},
        createObjectStore(key) { stores.set(key, new Map()); return { createIndex() {} }; },
        transaction(names, mode) {
          const snapshot = new Map(names.map(key => [key, new Map([...stores.get(key)].map(([id, value]) => [id, structuredClone(value)]))]));
          let pending = 0, finished = false;
          const tx = {
            error: null,
            abort() {
              if (finished) throw new Error('Transaction inactive');
              finished = true; setImmediate(() => tx.onabort?.());
            },
            objectStore(key) {
              const rows = snapshot.get(key);
              const request = operation => {
                const result = {}; pending++;
                setImmediate(() => {
                  if (finished) { result.error = new Error('Aborted'); result.onerror?.(); return; }
                  try { result.result = structuredClone(operation()); result.onsuccess?.(); }
                  catch (error) { result.error = error; tx.error = error; result.onerror?.(); tx.abort(); }
                  pending--; scheduleCompletion();
                });
                return result;
              };
              return {
                get: id => request(() => rows.get(id)),
                getAll: () => request(() => [...rows.values()]),
                add: value => request(() => { if (rows.has(value.id)) throw new Error('Duplicate key'); rows.set(value.id, structuredClone(value)); return value.id; }),
                put: value => request(() => {
                  if (api.failPutStore === key) { api.failPutStore = null; throw new DOMException('Quota exhausted', 'QuotaExceededError'); }
                  rows.set(value.id, structuredClone(value)); return value.id;
                }),
                delete: id => request(() => rows.delete(id)),
                index: () => ({
                  getAll: id => request(() => [...rows.values()].filter(value => value.recordingId === id)),
                  getAllKeys: id => request(() => [...rows.values()].filter(value => value.recordingId === id).map(value => value.id)),
                }),
              };
            },
          };
          function scheduleCompletion() {
            setImmediate(() => {
              if (finished || pending) return;
              finished = true;
              if (mode === 'readwrite') for (const [key, rows] of snapshot) stores.set(key, rows);
              tx.oncomplete?.();
            });
          }
          scheduleCompletion(); return tx;
        },
      };
      if (fresh) req.onupgradeneeded?.(); req.onsuccess?.();
    });
    return req;
  } };
  return api;
}

test('IndexedDB durable Blob roundtrip, atomic append rollback, recovery and explicit deletion', async () => {
  const indexedDB = fakeIndexedDB();
  const store = new IndexedDbStore({ indexedDB, name: 'test' });
  await store.createRecording({ id: 'idb', sessionId: 'conversation', selection: { language: 'en' } });
  await store.updateRecording('idb', { tailAudio: audio(7), tailUpdatedAt: 1 });
  assert.ok((await store.getRecording('idb')).tailAudio instanceof Blob);
  indexedDB.failPutStore = 'recordings';
  await assert.rejects(store.appendChunk('idb', audio(8)), { name: 'QuotaExceededError' });
  assert.deepEqual(await store.listChunks('idb'), []);
  assert.equal((await store.getRecording('idb')).nextSeq, 0);
  assert.ok((await store.getRecording('idb')).tailAudio);
  const item = await store.appendChunk('idb', audio(9));
  assert.ok(item.audio instanceof Blob); assert.deepEqual(new Uint8Array(await item.audio.arrayBuffer()), audio(9));
  assert.equal((await store.getRecording('idb')).tailAudio, undefined);
  await store.updateChunk(item.id, { status: 'done', text: 'saved', delivery: 'applied' });
  await store.updateRecording('idb', { tailAudio: audio(10), tailUpdatedAt: 2 }); await store.close();
  const reopened = new IndexedDbStore({ indexedDB, name: 'test' });
  await reopened.recover(); await reopened.recover();
  const chunks = await reopened.listChunks('idb');
  assert.equal(chunks.length, 2); assert.equal(chunks[0].text, 'saved'); assert.equal(chunks[0].delivery, 'applied');
  assert.equal(chunks[1].status, 'pending'); assert.ok(chunks[1].audio instanceof Blob);
  assert.equal((await reopened.getRecording('idb')).nextSeq, 2);
  assert.equal((await reopened.getRecording('idb')).state, 'interrupted');
  assert.equal((await reopened.listChunks('idb', { includeAudio: false }))[0].audio, undefined);
  await reopened.deleteRecording('idb'); assert.deepEqual(await reopened.listChunks('idb'), []);
  assert.equal(await reopened.getRecording('idb'), undefined); await reopened.close();
});

test('checkpoint notifications do not spin the worker or duplicate recognition', async () => {
  let calls = 0;
  const { store, queue } = await setup(async () => { calls++; return 'one'; });
  await queue.enqueue('rec', audio(1)); await queue.waitForIdle();
  for (let i = 0; i < 30; i++) await store.updateRecording('rec', { tailAudio: audio(i), tailUpdatedAt: i });
  await queue.waitForIdle(); assert.equal(queue.worker, null); assert.equal(calls, 1);
  await queue.close();
});

test('policy validation and transient classification', async () => {
  assert.equal(isTransientError({ status: 503 }), true); assert.equal(isTransientError({ status: 400 }), false);
  assert.equal(isTransientError({ retryable: false, message: 'network timeout' }), false);
  assert.throws(() => new DictationQueue({ store: new MemoryStore(), transcribe() {}, maxAttempts: 0 }), /retry/);
  const store = new MemoryStore(); await assert.rejects(store.createRecording({}), /sessionId/);
  await store.createRecording({ id: 'r', sessionId: 'a' });
  await assert.rejects(store.appendChunk('r', 'not bytes'), /audio/);
  await assert.rejects(store.updateRecording('r', { nextSeq: 99 }), /patch/);
});
