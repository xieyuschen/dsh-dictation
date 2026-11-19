import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const ROOT = new URL('./', import.meta.url);
let browser;
before(async () => {
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),
    headless: true,
    chromiumSandbox: process.env.PLAYWRIGHT_DISABLE_SANDBOX!=='1',
    // Playwright also adds these switches itself; remove its defaults unless opted in.
    ignoreDefaultArgs: process.env.PLAYWRIGHT_DISABLE_BACKGROUND_THROTTLING==='1'?[]:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],
    args: [...(process.env.PLAYWRIGHT_DISABLE_SANDBOX==='1'?['--no-sandbox']:[]), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(process.env.PLAYWRIGHT_DISABLE_BACKGROUND_THROTTLING==='1'?['--disable-background-timer-throttling','--disable-renderer-backgrounding']:[])],
  });
});
after(async () => { await browser?.close(); });

async function fixture() {
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.route('https://dictation.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Durable dictation browser tests</title><body>Local virtual-origin module test</body>', headers: { 'Cache-Control': 'no-store' } });
    if (!/^\/dictation-(capture|queue|store|service)\.js$/.test(pathname)) return route.abort();
    // Read each request afresh so the suite tests the latest working sources.
    return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(pathname.slice(1), ROOT), 'utf8'), headers: { 'Cache-Control': 'no-store' } });
  });
  const page = await context.newPage();
  await page.goto('https://dictation.test/');
  return { context, page };
}
async function service(page, mode = 'success') {
  return page.evaluate(async mode => {
    const { DictationService } = await import('/dictation-service.js');
    window.telemetry = { calls: [], active: 0, maxActive: 0 };
    window.remote = { speech: { transcribe: async (request, signal) => {
      const stats = window.telemetry;
      const attempt = stats.calls.length;
      const bytes = Uint8Array.from(atob(request.audioBase64), ch => ch.charCodeAt(0));
      stats.calls.push({ attempt, bytes: bytes.length, audio: request.audioBase64 });
      stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
      try {
        await window.requestEvent?.({ type: 'start', id: request.audioBase64 });
        if (signal.aborted) throw signal.reason;
        if (mode === 'hang' && !window.allowRequests) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        if (mode === 'retry' && attempt === 0) return { ok: false, error: { message: 'ASR returned HTTP 429: GPU ASR is busy' } };
        return { ok: true, value: { text: `chunk ${attempt}`, audioSeconds: (bytes.length - 44) / 32000, inferenceSeconds: 0.025 } };
      } finally { stats.active--; await window.requestEvent?.({ type: 'end', id: request.audioBase64 }); }
    } } };
    window.svc = new DictationService(window.remote);
    window.svc.queue.retryBaseMs = 30; window.svc.queue.retryMaxMs = 60;
    await window.svc.initialize();
    return { ready: window.svc.ready, owner: window.svc.owner, error: window.svc.error };
  }, mode);
}

async function inspectExport(page, id) {
  return page.evaluate(async id => {
    const svc = window.svc;
    const chunks = await svc.store.listChunks(id);
    const all = new Uint8Array(await (await svc.exportAudio(id)).arrayBuffer());
    const waves = [];
    for (const chunk of chunks) waves.push(new Uint8Array(await chunk.audio.arrayBuffer()));
    for (const entry of svc.unsaved) if (entry.recordingId === id) waves.push(entry.audio instanceof Uint8Array ? entry.audio : new Uint8Array(await entry.audio.arrayBuffer()));
    const expectedBytes = waves.reduce((sum, wav) => sum + wav.length - 44, 0);
    let offset = 44, equal = true;
    for (const wav of waves) for (let i = 44; i < wav.length; i++) if (wav[i] !== all[offset++]) equal = false;
    const view = new DataView(all.buffer);
    return { bytes: all.length, expectedBytes, equal, riff: view.getUint32(4, true), data: view.getUint32(40, true), statuses: chunks.map(c => c.status), chunkBytes: waves.map(w => w.length), seq: chunks.map(c => c.seq), blobs: chunks.every(c => c.audio instanceof Blob) };
  }, id);
}

test('real IndexedDB retains Blob WAV, rolls back failed append, and promotes tail exactly once after reopen', { timeout: 15000 }, async () => {
  const { context, page } = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const { IndexedDbStore } = await import('/dictation-store.js');
      const { pcmWave } = await import('/dictation-capture.js');
      const first = new IndexedDbStore({ name: 'browser-persistence' });
      await first.createRecording({ id: 'persisted', sessionId: 'conversation-a' });
      await first.appendChunk('persisted', pcmWave(new Int16Array([1, 2, 3])));
      await first.updateChunk('persisted:0', { status: 'done', text: 'saved text', delivery: 'applied' });
      await first.updateRecording('persisted', { tailAudio: pcmWave(new Int16Array([4, 5])), tailUpdatedAt: Date.now() });
      // The transaction must abort when recording update fails after the chunk add.
      const originalRun = first.run.bind(first);
      first.run = (names, mode, action) => originalRun(names, mode, async tx => {
        const result = await action(tx);
        if (names.length === 2 && mode === 'readwrite') { tx.abort(); }
        return result;
      });
      let failed = false;
      try { await first.appendChunk('persisted', pcmWave(new Int16Array([9]))); } catch { failed = true; }
      first.run = originalRun;
      const before = await first.getRecording('persisted');
      const beforeChunks = await first.listChunks('persisted');
      await first.close();
      const reopened = new IndexedDbStore({ name: 'browser-persistence' });
      await reopened.recover(); await reopened.recover();
      const record = await reopened.getRecording('persisted');
      const chunks = await reopened.listChunks('persisted');
      const metadata = await reopened.listChunks('persisted', { includeAudio: false });
      const answer = { failed, beforeSeq: before.nextSeq, beforeCount: beforeChunks.length, tailWasBlob: before.tailAudio instanceof Blob, state: record.state, nextSeq: record.nextSeq, tailCleared: !record.tailAudio, count: chunks.length, seq: chunks.map(c => c.seq), allBlob: chunks.every(c => c.audio instanceof Blob), texts: chunks.map(c => c.text), metadataOmitsAudio: metadata.every(c => !('audio' in c)), tailBytes: [...new Uint8Array(await chunks[1].audio.arrayBuffer()).slice(44)] };
      await reopened.deleteRecording('persisted');
      answer.deleted = !(await reopened.getRecording('persisted')) && !(await reopened.listChunks('persisted')).length;
      await reopened.close(); return answer;
    });
    assert.equal(result.failed, true); assert.equal(result.beforeSeq, 1); assert.equal(result.beforeCount, 1);
    assert.equal(result.tailWasBlob, true); assert.equal(result.state, 'interrupted'); assert.equal(result.nextSeq, 2);
    assert.equal(result.tailCleared, true); assert.equal(result.count, 2); assert.deepEqual(result.seq, [0, 1]);
    assert.equal(result.allBlob, true); assert.deepEqual(result.texts, ['saved text', '']);
    assert.equal(result.metadataOmitsAudio, true); assert.deepEqual(result.tailBytes, [4, 0, 5, 0]); assert.equal(result.deleted, true);
  } finally { await context.close(); }
});

test('real IndexedDB queue persists exhausted retry and blocks successors until manual retry', { timeout: 15000 }, async () => {
  const { context, page } = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const { IndexedDbStore } = await import('/dictation-store.js');
      const { DictationQueue } = await import('/dictation-queue.js');
      const { pcmWave } = await import('/dictation-capture.js');
      const store = new IndexedDbStore(); let allow = false, active = 0, maximum = 0;
      const calls = [];
      const queue = new DictationQueue({ store, retryBaseMs: 5, retryMaxMs: 10, transcribe: async (audio, signal, chunk) => {
        active++; maximum = Math.max(maximum, active); calls.push(chunk.seq);
        try { await new Promise(resolve => setTimeout(resolve, 15)); if (!allow) throw new Error('HTTP 429 busy'); return `text ${chunk.seq}`; }
        finally { active--; }
      } });
      await queue.start(); await store.createRecording({ id: 'ordered', sessionId: 'ordered' });
      await queue.enqueue('ordered', pcmWave(new Int16Array([10])));
      await queue.enqueue('ordered', pcmWave(new Int16Array([20]))); await queue.waitForIdle();
      const failed = await store.listChunks('ordered'); const failedCalls = [...calls];
      allow = true; await queue.retry(failed[0].id); await queue.waitForIdle();
      const done = await store.listChunks('ordered');
      const answer = { maximum, failedCalls, failedStatuses: failed.map(c => c.status), failedAttempts: failed.map(c => c.attempts), audioRetained: failed.every(c => c.audio instanceof Blob), calls, done: done.map(c => ({ status: c.status, text: c.text })) };
      await queue.close(); await store.close(); return answer;
    });
    assert.equal(result.maximum, 1); assert.deepEqual(result.failedCalls, [0, 0, 0]);
    assert.deepEqual(result.failedStatuses, ['failed', 'pending']); assert.deepEqual(result.failedAttempts, [3, 0]);
    assert.equal(result.audioRetained, true); assert.deepEqual(result.calls, [0, 0, 0, 0, 1]);
    assert.deepEqual(result.done, [{ status: 'done', text: 'text 0' }, { status: 'done', text: 'text 1' }]);
  } finally { await context.close(); }
});

test('live follower automatically owns Web Lock after owner tab closes without recreating service', { timeout: 15000 }, async () => {
  const { context, page } = await fixture();
  try {
    assert.equal((await service(page)).owner, true);
    const other = await context.newPage(); await other.goto('https://dictation.test/');
    const follower = await service(other); assert.equal(follower.ready, true); assert.equal(follower.owner, false);
    await other.evaluate(() => { window.originalService = window.svc; });
    await page.close();
    await other.waitForFunction(() => window.svc.owner, null, { timeout: 7000 });
    assert.equal(await other.evaluate(() => window.svc === window.originalService), true);
    const locks = await other.evaluate(() => navigator.locks.query());
    assert.equal(locks.held.filter(lock => lock.name === 'dsh-dictation-worker-v1').length, 1);
    await other.evaluate(() => window.svc.dispose());
  } finally { await context.close(); }
});

test('idle owner cooperatively yields durable in-flight ASR without overlap and can later retake ownership', { timeout: 25000 }, async () => {
  const { context, page } = await fixture();
  const running = new Set(); let maximum = 0;
  await context.exposeBinding('requestEvent', ({ page: source }, event) => {
    const key = source === page ? 'original' : 'successor';
    if (event.type === 'start') { assert.equal(running.has(key), false); running.add(key); maximum = Math.max(maximum, running.size); }
    else running.delete(key);
  });
  try {
    await service(page, 'hang');
    await page.evaluate(async () => {
      const { pcmWave } = await import('/dictation-capture.js');
      await window.svc.store.createRecording({ id: 'handoff-durable', sessionId: 'seed', state: 'stopped' });
      await window.svc.queue.enqueue('handoff-durable', pcmWave(new Int16Array([11, 12])));
      await window.svc.queue.enqueue('handoff-durable', pcmWave(new Int16Array([21, 22, 23])));
    });
    await page.waitForFunction(() => window.telemetry.active === 1);
    const other = await context.newPage(); await other.goto('https://dictation.test/');
    assert.equal((await service(other)).owner, false);
    await other.evaluate(() => window.svc.start('handoff-follower'));
    assert.equal(await page.evaluate(() => window.svc.owner), false);
    assert.equal(await other.evaluate(() => window.svc.owner && !!window.svc.capture), true);
    const durable = await other.evaluate(async () => {
      await window.svc.queue.waitForIdle();
      const chunks = await window.svc.store.listChunks('handoff-durable');
      return { chunks: chunks.map(chunk => ({ seq: chunk.seq, status: chunk.status, bytes: chunk.audio.size, attempts: chunk.attempts })), requests: window.telemetry.calls.map(call => call.bytes) };
    });
    assert.deepEqual(durable.chunks.map(chunk => [chunk.seq, chunk.status, chunk.bytes]), [[0, 'done', 48], [1, 'done', 50]]);
    assert.deepEqual(durable.requests, [48, 50]);
    assert.ok(durable.chunks[0].attempts >= 2, 'Aborted first request must remain durable and be retried');
    assert.equal(maximum, 1, 'Requests across both tabs must never overlap');
    await other.evaluate(async () => { await window.svc.stop(); await window.svc.queue.waitForIdle(); });
    await page.evaluate(async () => { window.allowRequests = true; await window.svc.start('original-retakes'); });
    assert.equal(await page.evaluate(() => window.svc.owner && !!window.svc.capture), true);
    assert.equal(await other.evaluate(() => window.svc.owner), false);
    await page.evaluate(async () => { await window.svc.stop(); await window.svc.queue.waitForIdle(); });
    await other.evaluate(() => window.svc.dispose());
    await page.evaluate(() => window.svc.dispose());
    assert.equal(maximum, 1);
    assert.equal(running.size, 0);
  } finally { await context.close(); }
});

test('active owner refuses takeover before follower microphone opens; cancelled and disposed followers never revive', { timeout: 18000 }, async () => {
  const { context, page } = await fixture();
  try {
    await service(page);
    await page.evaluate(() => window.svc.start('active-owner'));
    const other = await context.newPage(); await other.goto('https://dictation.test/');
    assert.equal((await service(other)).owner, false);
    await other.evaluate(() => {
      window.microphoneCalls = 0;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { window.microphoneCalls++; return getUserMedia(...args); };
    });
    const refusal = await other.evaluate(async () => { try { await window.svc.start('must-refuse'); return ''; } catch (error) { return error.message; } });
    assert.match(refusal, /另一个|其他/); assert.match(refusal, /暂停|录音/);
    assert.equal(await other.evaluate(() => window.microphoneCalls), 0);
    assert.equal(await other.evaluate(() => !!window.svc.capture || window.svc.owner), false);
    assert.equal(await page.evaluate(() => window.svc.owner && !!window.svc.capture), true);
    const cancelled = await other.evaluate(async () => {
      const task = window.svc.start('cancel-ownership-wait').then(() => 'unexpected success', error => error.name);
      const wasStarting = window.svc.starting;
      await window.svc.stop();
      return { wasStarting, result: await task, waiters: window.svc.ownershipWaiters.size };
    });
    assert.equal(cancelled.wasStarting, true); assert.equal(cancelled.result, 'AbortError'); assert.equal(cancelled.waiters, 0);
    await other.evaluate(() => window.svc.dispose());
    await page.evaluate(() => window.svc.dispose());
    // Observe beyond the retry interval: a disposed follower must not reacquire
    // a newly free real Web Lock or reopen its microphone.
    const lifecycle = await other.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 1700));
      const locks = await navigator.locks.query();
      return { disposed: window.svc.disposed, owner: window.svc.owner, ready: window.svc.ready, timer: window.svc.ownershipTimer, waiters: window.svc.ownershipWaiters.size, microphones: window.microphoneCalls, held: locks.held.filter(lock => lock.name === 'dsh-dictation-worker-v1').length };
    });
    assert.equal(lifecycle.disposed, true); assert.equal(lifecycle.owner, false); assert.equal(lifecycle.ready, false);
    assert.equal(lifecycle.waiters, 0); assert.equal(lifecycle.microphones, 0); assert.equal(lifecycle.held, 0);
  } finally { await context.close(); }
});

test('real microphone AudioWorklet >=32 seconds: serial 429 retry, final tail, exact WAV export', { timeout: 65000 }, async () => {
  const { context, page } = await fixture();
  try {
    assert.equal((await service(page, 'retry')).owner, true);
    const id = await page.evaluate(async () => (await window.svc.start('mic-conversation')).id);
    await page.waitForFunction(() => window.svc.capture?.segmenter.totalSamples >= 32 * 16000, null, { timeout: 50000 });
    const captured = await page.evaluate(async () => {
      const capture = window.svc.capture;
      await window.svc.stop(); await window.svc.queue.waitForIdle(); await window.svc.refresh();
      return { samples: capture.segmenter.totalSamples, tracksEnded: capture.stream.getTracks().every(t => t.readyState === 'ended'), contextState: capture.context.state, record: await window.svc.store.getRecording(window.svc.currentId), calls: window.telemetry.calls.map(c => ({ attempt: c.attempt, bytes: c.bytes })), maxActive: window.telemetry.maxActive, error: window.svc.error };
    });
    const exported = await inspectExport(page, id);
    assert.equal(captured.error, ''); assert.ok(captured.samples >= 32 * 16000); assert.equal(captured.maxActive, 1);
    assert.equal(captured.tracksEnded, true); assert.equal(captured.contextState, 'closed'); assert.equal(captured.record.state, 'stopped');
    assert.equal(exported.blobs, true); assert.equal(exported.statuses.length, 2); assert.ok(exported.statuses.every(s => s === 'done'));
    const firstSeconds = (exported.chunkBytes[0] - 44) / 32000;
    const tailSeconds = (exported.chunkBytes[1] - 44) / 32000;
    assert.ok(firstSeconds >= 28 && firstSeconds <= 30, `Expected28–30second first chunk, got ${firstSeconds}`);
    assert.ok(tailSeconds > 0 && tailSeconds < 5, `Expected a short stop tail, got ${tailSeconds}`);
    assert.equal(captured.calls.length, exported.statuses.length + 1); // first chunk retried, never skipped
    assert.equal(captured.calls[0].bytes, captured.calls[1].bytes);
    assert.equal(exported.equal, true); assert.equal(exported.bytes, 44 + captured.samples * 2);
    assert.equal(exported.data, captured.samples * 2); assert.equal(exported.riff, exported.bytes - 8);
    assert.equal(exported.expectedBytes, captured.samples * 2);
    assert.deepEqual(exported.seq, exported.seq.map((_, i) => i));
    await page.evaluate(() => window.svc.dispose());
  } finally { await context.close(); }
});

test('storage failure stops microphone; unsaved export excludes persisted checkpoint prefix duplication', { timeout: 20000 }, async () => {
  const { context, page } = await fixture();
  try {
    await service(page);
    const id = await page.evaluate(async () => {
      const rec = await window.svc.start('quota-conversation');
      const seg = window.svc.capture.segmenter; seg.target = 32000; seg.max = 32000;
      const original = window.svc.store.appendChunk.bind(window.svc.store);
      let writes = 0;
      window.svc.store.appendChunk = async (...args) => { if (++writes >= 2) throw new DOMException('Injected quota exceeded', 'QuotaExceededError'); return original(...args); };
      window.failedCapture = window.svc.capture; return rec.id;
    });
    await page.waitForFunction(() => window.svc.blocked && !window.svc.capture, null, { timeout: 12000 });
    const state = await page.evaluate(async () => {
      await window.svc.writes;
      const emergency = new Uint8Array(await (await window.svc.exportAudio(window.svc.currentId, { unsavedOnly: true })).arrayBuffer());
      const unsavedSamples = window.svc.unsaved.reduce((n, c) => n + (c.audio.byteLength - 44) / 2, 0);
      return { error: window.svc.error, samples: window.failedCapture.segmenter.totalSamples, ended: window.failedCapture.stream.getTracks().every(t => t.readyState === 'ended'), unsavedCount: window.svc.unsaved.length, unsavedSamples, emergencyBytes: emergency.length, persistedTail: !!(await window.svc.store.getRecording(window.svc.currentId)).tailAudio };
    });
    const exported = await inspectExport(page, id);
    assert.match(state.error, /本地保存失败/); assert.equal(state.ended, true); assert.ok(state.unsavedCount >= 1);
    assert.equal(state.emergencyBytes, 44 + state.unsavedSamples * 2); assert.equal(exported.equal, true);
    assert.equal(exported.bytes, 44 + state.samples * 2); assert.equal(exported.data, state.samples * 2);
    assert.ok(exported.statuses.length >= 1); await page.evaluate(() => window.svc.dispose());
  } finally { await context.close(); }
});

test('actual renderer crash recovers latest microphone tail exactly once in a fresh service', { timeout: 25000 }, async () => {
  const { context, page } = await fixture();
  try {
    await service(page, 'hang');
    const id = await page.evaluate(async () => {
      const record = await window.svc.start('crash-conversation');
      const { pcmWave } = await import('/dictation-capture.js');
      await window.svc.queue.enqueue(record.id, pcmWave(new Int16Array([31, 32])));
      return record.id;
    });
    await page.waitForFunction(() => window.svc.capture?.segmenter.totalSamples >= 2.2 * 16000, null, { timeout: 10000 });
    const saved = await page.evaluate(async () => {
      await window.svc.writes;
      const rec = await window.svc.store.getRecording(window.svc.currentId);
      const chunks = await window.svc.store.listChunks(rec.id);
      return { bytes: rec.tailAudio.size, nextSeq: rec.nextSeq, inflight: chunks[0]?.status };
    });
    assert.equal(saved.inflight, 'transcribing');
    const cdp = await context.newCDPSession(page);
    const crashed = page.waitForEvent('crash');
    // Page.crash intentionally never replies on some Chromium versions.
    cdp.send('Page.crash').catch(() => {});
    await crashed;
    const restored = await context.newPage(); await restored.goto('https://dictation.test/');
    assert.equal((await service(restored)).owner, true);
    const recovered = await restored.evaluate(async id => {
      await window.svc.queue.waitForIdle();
      const chunks = await window.svc.store.listChunks(id);
      const rec = await window.svc.store.getRecording(id);
      return { count: chunks.length, state: rec.state, nextSeq: rec.nextSeq, statuses: chunks.map(c => c.status), bytes: chunks[1]?.audio.size, tailCleared: !rec.tailAudio, calls: window.telemetry.calls.length, maxActive: window.telemetry.maxActive };
    }, id);
    assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.count, 2); assert.equal(recovered.nextSeq, saved.nextSeq + 1);
    assert.deepEqual(recovered.statuses, ['done', 'done']); assert.equal(recovered.bytes, saved.bytes); assert.equal(recovered.tailCleared, true); assert.equal(recovered.calls, 2); assert.equal(recovered.maxActive, 1);
    await restored.evaluate(() => window.svc.dispose());
  } finally { await context.close(); }
});


test('catalog choices snapshot default omission and explicit language/provider in durable records', { timeout: 15000 }, async () => {
  const { context, page } = await fixture();
  try {
    await service(page);
    const result = await page.evaluate(async () => {
      const svc=window.svc;
      const value={providers:[{id:'default-backend',name:'Default',languages:['auto','en']},{id:'explicit-backend',name:'Explicit',languages:['auto','zh']}],selection:{providerId:'default-backend',language:'en'},maxDurationSeconds:30,maxAudioBytes:960044};
      window.remote.speech.catalog=async()=>({ok:true,value});await svc.refreshCatalog();
      const first=await svc.start('default-selection');await svc.stop();
      const second=await svc.start('explicit-selection',{providerId:'explicit-backend',language:'zh'});await svc.stop();
      value.providers[1].languages=['ja'];value.selection.providerId='changed-default';
      const records=await Promise.all([svc.store.getRecording(first.id),svc.store.getRecording(second.id)]);
      await svc.dispose();return records;
    });
    assert.deepEqual(result[0].selection,{language:'auto'});assert.equal(result[0].resolvedProviderId,'default-backend');
    assert.deepEqual(result[1].selection,{providerId:'explicit-backend',language:'zh'});
  } finally { await context.close(); }
});

test('pending microphone permission cancellation releases lock promptly and late stream never writes closed store', { timeout: 15000 }, async () => {
  const { context, page } = await fixture();
  try {
    await service(page);
    await page.evaluate(() => {
      window.lateStops=0;window.postCloseWrites=0;window.storeClosed=false;
      navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{window.resolvePermission=resolve;});
      const store=window.svc.store;
      for(const method of ['createRecording','updateRecording','appendChunk']){
        const original=store[method].bind(store);store[method]=(...args)=>{if(window.storeClosed)window.postCloseWrites++;return original(...args);};
      }
      const close=store.close.bind(store);store.close=()=>{window.storeClosed=true;return close();};
      window.startResult=window.svc.start('pending-permission').then(()=> 'unexpected success',error=>error.name);
    });
    await page.waitForFunction(()=>!!window.resolvePermission);
    const result=await page.evaluate(async()=>{
      const started=performance.now();await window.svc.stop();await window.svc.dispose();
      return {elapsed:performance.now()-started,result:await window.startResult,disposed:window.svc.disposed,held:(await navigator.locks.query()).held.filter(lock=>lock.name==='dsh-dictation-worker-v1').length};
    });
    assert.ok(result.elapsed<1500,`dispose took ${result.elapsed}ms`);assert.equal(result.result,'AbortError');assert.equal(result.disposed,true);assert.equal(result.held,0);
    const other=await context.newPage();await other.goto('https://dictation.test/');assert.equal((await service(other)).owner,true);
    await page.evaluate(()=>window.resolvePermission({getTracks:()=>[{stop:()=>{window.lateStops++;}}]}));
    await page.waitForFunction(()=>window.lateStops>0);
    assert.equal(await page.evaluate(()=>window.postCloseWrites),0);
    await other.evaluate(()=>window.svc.dispose());
  } finally { await context.close(); }
});
