import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from './index.js';
import { pcmWave } from './dictation-capture.js';

const defer = () => Promise.withResolvers();
const options = (extra = {}) => ({ enabled: true, endpoint: 'https://asr.example.com/v1/audio/transcriptions', model: 'your-model', ...extra });
function registry() {
  const value = { current: null, starts: [], ends: [], defaultProvider: 'unchanged-provider', gate: null, closing: null };
  value.register = provider => {
    assert.equal(value.current, null, 'Previous registration must finish disposal first');
    value.current = provider;
    value.starts.push(provider.info);
    let removed = false;
    return async () => {
      if (removed) return;
      removed = true;
      value.closing?.resolve();
      await value.gate?.promise;
      assert.equal(value.current, provider);
      value.current = null;
      value.ends.push(provider.info);
    };
  };
  return value;
}
async function fixture(config = {}) {
  const ctx = new Context();
  const service = registry();
  ctx.provide('speechToText', service);
  const fiber = ctx.plugin(plugin, config);
  await fiber;
  return { ctx, service, fiber, close: () => fiber.dispose() };
}

test('native Config exposes one volatile object, disabled defaults and schema-declared secret', () => {
  const schema = plugin.Config;
  assert.equal(schema.dict.asr.meta.volatile, true);
  assert.equal(schema.dict.asr.dict.apiKey.meta.role, 'secret');
  const resolved = schema({});
  assert.equal(typeof resolved.asr.get, 'function');
  assert.equal(resolved.asr.subscribe, undefined);
  assert.deepEqual(resolved.asr.get(), {
    enabled: false, endpoint: '', model: '', apiKey: '', hostHeader: '', timeoutMs: 180000,
    providerId: 'dsh-dictation-compatible', providerName: 'Compatible ASR', languages: ['auto'],
    advancedMode: false,
  });
  // Traverse the actual schema exactly where a structural Settings redactor finds
  // secret metadata; the API key is NOT hidden merely by a cosmetic input type.
  const secretPaths = [];
  function walk(node, path = []) {
    if (node.meta?.role === 'secret') secretPaths.push(path.join('.'));
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key]);
  }
  walk(schema);
  assert.deepEqual(secretPaths, ['asr.apiKey']);
  assert.throws(() => schema({ asr: { timeoutMs: 49 } }));
  assert.throws(() => schema({ asr: { timeoutMs: 300001 } }));
});

test('actual Cordis starts disabled, enables via local update without restart, never changes host default', async () => {
  const f = await fixture();
  try {
    assert.equal(f.service.current, null);
    const context = f.fiber.context;
    await f.fiber.update({ asr: options() });
    assert.equal(f.fiber.context, context);
    assert.equal(f.service.current.info.id, 'dsh-dictation-compatible');
    assert.equal(f.service.starts.length, 1);
    assert.equal(f.service.defaultProvider, 'unchanged-provider');
    await f.fiber.update({ asr: { enabled: false } });
    assert.equal(f.service.current, null);
    assert.equal(f.service.ends.length, 1);
  } finally { await f.close(); }
});

test('transport updates keep registration and in-flight immutable request snapshot', { timeout: 8000 }, async () => {
  const arrivals = [defer(), defer()];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const index = requests.length;
    requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8'), response });
    arrivals[index]?.resolve();
  });
  server.listen(0, 'localhost'); await once(server, 'listening');
  const endpoint = ['http:', '', 'localhost:' + server.address().port, 'first'].join('/');
  const firstKey = ['synthetic', 'one'].join('-');
  const secondKey = ['synthetic', 'two'].join('-');
  const f = await fixture({ asr: options({ endpoint, apiKey: firstKey, hostHeader: 'asr.example.com' }) });
  try {
    const registered = f.service.current;
    const input = { audio: pcmWave(new Int16Array(160)), language: 'auto' };
    const first = registered.transcribe(input);
    await arrivals[0].promise;
    await f.fiber.update({ asr: options({ endpoint: endpoint.replace('/first', '/second'), model: 'new-model', apiKey: secondKey, hostHeader: 'other.asr.example.com', timeoutMs: 200000 }) });
    assert.equal(f.service.current, registered);
    assert.equal(f.service.starts.length, 1);
    assert.equal(f.service.ends.length, 0);
    const second = registered.transcribe(input);
    await arrivals[1].promise;
    for (const [index, captured] of requests.entries()) {
      const expected = index ? 'new-model' : 'your-model';
      assert.ok(captured.body.includes(expected));
      assert.equal(captured.path, index ? '/second' : '/first');
      assert.equal(captured.headers.authorization, 'Bearer ' + (index ? secondKey : firstKey));
      assert.equal(captured.headers.host, index ? 'other.asr.example.com' : 'asr.example.com');
      captured.response.writeHead(200, { 'Content-Type': 'application/json' });
      captured.response.end(JSON.stringify({ text: index ? 'second' : 'first' }));
    }
    assert.equal((await first).text, 'first');
    assert.equal((await second).text, 'second');
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('identity and language changes await old unregister; disable also waits', async () => {
  const f = await fixture({ asr: options() });
  try {
    for (const change of [{ providerId: 'second-provider' }, { providerName: 'New name' }, { languages: ['auto', 'en'] }]) {
      f.service.gate = defer(); f.service.closing = defer();
      const before = f.service.starts.length;
      const task = f.fiber.update({ asr: options(change) });
      await f.service.closing.promise;
      assert.equal(f.service.starts.length, before);
      f.service.gate.resolve();
      await task;
      assert.equal(f.service.starts.length, before + 1);
    }
    f.service.gate = defer(); f.service.closing = defer();
    let settled = false;
    const stop = f.fiber.update({ asr: { enabled: false } }).then(() => { settled = true; });
    await f.service.closing.promise;
    assert.equal(settled, false);
    f.service.gate.resolve(); await stop;
    assert.equal(f.service.current, null);
  } finally { f.service.gate?.resolve(); await f.close(); }
});

test('disposal racing a pending identity replacement prevents late registration', async () => {
  const f = await fixture({ asr: options() });
  f.service.gate = defer(); f.service.closing = defer();
  const update = f.fiber.update({ asr: options({ providerId: 'late-provider' }) });
  await f.service.closing.promise;
  const dispose = f.close();
  // Release immediately: teardown effects may not have run yet when Cordis
  // already marks the fiber disposed. There must still be no late registration.
  f.service.gate.resolve();
  await Promise.all([update, dispose]);
  assert.equal(f.service.current, null);
  assert.equal(f.service.starts.length, 1);
  assert.equal(f.service.ends.length, 1);
});

test('invalid enabled candidate is sanitized and leaves active registration usable', async () => {
  const f = await fixture({ asr: options() });
  try {
    const original = f.service.current;
    const sensitive = ['sensitive', 'example'].join('-');
    await assert.rejects(async () => f.fiber.update({ asr: options({ endpoint: sensitive }) }), error => {
      assert.match(error.message, /Invalid ASR settings/);
      assert.ok(!error.message.includes(sensitive));
      return true;
    });
    assert.equal(f.service.current, original);
    assert.equal(f.service.starts.length, 1);
    await f.fiber.update({ asr: options({ model: 'corrected-model' }) });
    assert.equal(f.service.current, original);
  } finally { await f.close(); }
});
