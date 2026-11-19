import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createProvider } from './provider.js';

const base = overrides => ({ endpoint: 'http://localhost/v1/audio/transcriptions', model: 'example-model', ...overrides });
const signal = () => new AbortController().signal;
function wav(seconds = 1) {
  const bytes = Buffer.alloc(44 + Math.round(seconds * 16000) * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const endpoint = new URL(base().endpoint); endpoint.port = String(instance.address().port);
  return { instance, endpoint: endpoint.href };
}
async function mock(t, handler, config = {}) {
  const fixture = await server(t, handler);
  return { ...fixture, provider: createProvider(base({ endpoint: fixture.endpoint, ...config })) };
}
async function requestData(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return { headers: request.headers, bytes: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') };
}

// Synthetic audio and test-only credentials; no configured backend is contacted.
test('multipart contains exact WAV, configured model, automatic language omission and inferred Host', async t => {
  let received;
  const { provider, endpoint } = await mock(t, async (req, res) => {
    received = await requestData(req); res.end(JSON.stringify({ text: '  synthetic transcript  ' }));
  }, { model: 'vendor/model:version + multilingual 模型' });
  const audio = wav(); const result = await provider.transcribe({ audio }, signal());
  assert.equal(result.text, 'synthetic transcript'); assert.equal(result.audioSeconds, 1); assert.ok(result.inferenceSeconds >= 0);
  assert.equal(received.headers.host, new URL(endpoint).host); assert.equal(received.headers.authorization, undefined);
  assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=dsh-dictation-/);
  assert.equal(Number(received.headers['content-length']), received.bytes.length);
  assert.match(received.body, /name="model"\r\n\r\nvendor\/model:version \+ multilingual 模型\r\n/);
  assert.match(received.body, /name="response_format"\r\n\r\njson\r\n/);
  assert.match(received.body, /filename="recording.wav"\r\nContent-Type: audio\/wav/);
  assert.doesNotMatch(received.body, /name="language"/); assert.ok(received.bytes.includes(audio));
  assert.deepEqual(provider.info, { id: 'dsh-dictation-compatible', name: 'Compatible ASR', location: 'cloud', languages: ['auto'] });
  assert.equal(JSON.stringify(provider).includes(endpoint), false);
});

test('configured language, explicit Host and optional Bearer header are forwarded only server-side', async t => {
  let received; const credential = ['test-only', 'credential'].join('-');
  const config = { hostHeader: 'gateway.example.test:8080', apiKey: credential, languages: ['auto', 'zh', 'en-US'], providerId: 'test-compatible', providerName: 'Synthetic ASR' };
  const { provider } = await mock(t, async (req, res) => { received = await requestData(req); res.end('{"text":""}'); }, config);
  config.languages.push('ja');
  assert.equal((await provider.transcribe({ audio: wav(), language: 'zh' }, signal())).text, '');
  assert.match(received.body, /name="language"\r\n\r\nzh\r\n/);
  assert.equal(received.headers.host, config.hostHeader); assert.equal(received.headers.authorization, `Bearer ${credential}`);
  assert.deepEqual(provider.info.languages, ['auto', 'zh', 'en-US']);
  assert.equal(JSON.stringify(provider.info).includes(credential), false); assert.equal(Object.hasOwn(provider.info, 'hostHeader'), false);
  assert.throws(() => provider.info.languages.push('ja'));
});

test('invalid config is rejected without reflecting supplied values', () => {
  const marker = 'test-only-sensitive-marker';
  const invalid = [undefined, null, [], {}, base({ endpoint: undefined }), base({ model: undefined }),
    base({ endpoint: ['https:', '//', marker, '@localhost/asr'].join('') }), base({ endpoint: 'ftp://localhost/asr' }), base({ endpoint: 'http:localhost/asr' }), base({ endpoint: ['http:', '//', '@localhost/asr'].join('') }),
    base({ endpoint: `http://localhost/asr?${marker}` }), base({ endpoint: `http://localhost/asr#${marker}` }),
    base({ endpoint: 'http://localhost/asr?' }), base({ endpoint: 'http://localhost/asr#' }),
    base({ endpoint: ['http:', '//local', '\nhost/', marker].join('') }), base({ endpoint: ` ${marker}` }),
    base({ model: `${marker}\r\ninjected` }), base({ model: '' }), base({ model: 'x'.repeat(129) }),
    base({ apiKey: [marker, '\r\nInjected: value'].join('') }), base({ apiKey: '非ASCII' }),
    base({ hostHeader: `${marker}\nHost: other` }), base({ hostHeader: 'localhost/path' }), base({ hostHeader: 'localhost:99999' }), base({ hostHeader: 'localhost:' }),
    base({ timeoutMs: 49 }), base({ timeoutMs: 300001 }), base({ timeoutMs: 50.5 }),
    base({ providerId: 'bad/id' }), base({ providerName: `bad\n${marker}` }),
    base({ languages: [] }), base({ languages: ['auto', 'auto'] }), base({ languages: ['zh\r\ninjected'] }),
    base({ languages: Array.from({ length: 33 }, (_, i) => 'en-' + String(i).padStart(2, '0')) })];
  for (const config of invalid) assert.throws(() => createProvider(config), error => !error.message.includes(marker));
  assert.doesNotThrow(() => createProvider(base({ hostHeader: '', apiKey: '' })));
  assert.doesNotThrow(() => createProvider(base({ hostHeader: '[2001:db8::1]:8080' })));
});

test('noncanonical WAV and unsupported language are rejected before upload, 120 second boundary is accepted', async t => {
  let uploads = 0;
  const { provider } = await mock(t, async (req, res) => { uploads++; await requestData(req); res.end('{"text":"ok"}'); });
  const audio = wav();
  const invalid = [Buffer.alloc(0), Buffer.alloc(45), new ArrayBuffer(48), wav(0), wav(120 + 1 / 16000), audio.subarray(0, -1)];
  for (const [offset, value] of [[20, 3], [22, 2], [24, 8000], [28, 16000], [32, 4], [34, 32], [40, 2], [4, 1]]) {
    const mutated = Buffer.from(audio); mutated.writeUInt16LE(value, offset); invalid.push(mutated);
  }
  for (const offset of [0, 8, 12, 36]) { const mutated=Buffer.from(audio); mutated[offset]^=1; invalid.push(mutated); }
  for (const bytes of invalid) await assert.rejects(provider.transcribe({ audio: bytes }, signal()), /WAV|120 seconds/);
  await assert.rejects(provider.transcribe({ audio, language: 'zh' }, signal()), /Unsupported ASR language/);
  assert.equal(uploads, 0);
  assert.equal((await provider.transcribe({ audio: wav(120) }, signal())).audioSeconds, 120); assert.equal(uploads, 1);
});

for (const status of [301, 302, 307, 308, 400, 401, 403, 408, 413, 425, 429, 500, 503]) {
  test(`HTTP ${status} keeps safe status/retryability without response/config diagnostics`, async t => {
    const marker = 'test-only-sensitive-marker';
    const { provider } = await mock(t, (req, res) => { res.writeHead(status); res.end(marker); }, { model: marker, hostHeader: 'redaction.example.test', apiKey: marker });
    await assert.rejects(provider.transcribe({ audio: wav() }, signal()), error => {
      assert.equal(error.message, `ASR returned HTTP ${status}`); assert.equal(error.status, status);
      assert.equal(error.retryable, [408, 425, 429].includes(status) || status >= 500);
      assert.equal(error.cause, undefined); assert.equal(error.message.includes(marker), false); return true;
    });
  });
}

test('redirect never contacts a second target', async t => {
  let secondUploads = 0;
  const second = await server(t, (req, res) => { secondUploads++; res.end('{"text":"must not upload"}'); });
  const { provider } = await mock(t, (req, res) => { res.writeHead(307, { Location: second.endpoint }); res.end(); });
  await assert.rejects(provider.transcribe({ audio: wav() }, signal()), /HTTP 307/); assert.equal(secondUploads, 0);
});

for (const [body, expected] of [['<html>test-only-sensitive-response</html>', /invalid JSON/], ['{}', /missing transcription text/], ['{"text":1}', /missing transcription text/], ['x'.repeat(65537), /64 KiB/]]) {
  test(`bounded/sanitized response validation: ${expected}`, async t => {
    const { provider } = await mock(t, (req, res) => res.end(body));
    await assert.rejects(provider.transcribe({ audio: wav() }, signal()), error => expected.test(error.message) && !error.message.includes('test-only-sensitive-response'));
  });
}

test('response cap applies incrementally and exactly 64 KiB is accepted', async t => {
  const body = JSON.stringify({ text: 'x'.repeat(65525) }); assert.equal(Buffer.byteLength(body), 65536);
  const { provider } = await mock(t, (req, res) => res.end(body));
  assert.equal((await provider.transcribe({ audio: wav() }, signal())).text.length, 65525);
});

test('timeout destroys request and is retryable without endpoint disclosure', async t => {
  let closed;
  const closure = new Promise(resolve => { closed = resolve; });
  const { provider } = await mock(t, (req, res) => { res.on('close', closed); }, { timeoutMs: 50 });
  await assert.rejects(provider.transcribe({ audio: wav() }, signal()), error => error.message === 'ASR request timed out' && error.retryable);
  await closure;
});

test('active cancellation closes request and never exposes caller abort reason', async t => {
  const controller = new AbortController(); let closed;
  const closure = new Promise(resolve => { closed = resolve; });
  const { provider } = await mock(t, (req, res) => { res.on('close', closed); controller.abort(new Error('test-only-sensitive-caller-reason')); });
  await assert.rejects(provider.transcribe({ audio: wav() }, controller.signal), error => error.name === 'AbortError' && error.message === 'ASR request cancelled' && error.cause === undefined);
  await closure;
});

test('pre-cancelled request never uploads or discloses abort reason', async t => {
  let uploads = 0; const controller = new AbortController(); controller.abort(new Error('test-only-sensitive-caller-reason'));
  const { provider } = await mock(t, (req, res) => { uploads++; res.end('{}'); });
  await assert.rejects(provider.transcribe({ audio: wav() }, controller.signal), error => error.name === 'AbortError' && error.message === 'ASR request cancelled');
  assert.equal(uploads, 0);
});

test('connection reset errors are sanitized and retryable', async t => {
  const { provider } = await mock(t, req => req.socket.destroy());
  await assert.rejects(provider.transcribe({ audio: wav() }, signal()), error => error.message === 'ASR network request failed' && error.retryable && error.cause === undefined);
});


test('HTTPS Host override preserves endpoint peer identity, normal certificate validation and IP SNI behavior', async t => {
  let captured;
  t.mock.method(https, 'request', (url, options, callback) => {
    captured = { url, options };
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough(); response.statusCode = 200; callback(response); response.end('{"text":"synthetic"}');
    };
    return request;
  });
  for (const [endpoint, servername] of [['https://asr.example.com/asr', 'asr.example.com'], [['https:', '//[2001:db8::1]/asr'].join(''), '']]) {
    const provider = createProvider(base({ endpoint, hostHeader: 'gateway.example.test' }));
    assert.equal((await provider.transcribe({ audio: wav() }, signal())).text, 'synthetic');
    assert.equal(captured.options.headers.Host, 'gateway.example.test'); assert.equal(captured.options.servername, servername);
    assert.notEqual(captured.options.rejectUnauthorized, false); assert.equal(captured.options.checkServerIdentity, undefined);
    assert.equal(captured.url.href, endpoint);
  }
});

test('unexpected synchronous transport exceptions cannot expose sensitive request options', async t => {
  t.mock.method(http, 'request', () => { throw new Error('test-only-sensitive-transport-diagnostics'); });
  await assert.rejects(createProvider(base()).transcribe({ audio: wav() }, signal()), error => error.message === 'ASR network request failed' && error.cause === undefined);
});

test('chunked response overflow is bounded across successive network writes', async t => {
  const { provider } = await mock(t, (req, res) => { res.write('x'.repeat(32768)); res.write('x'.repeat(32768)); res.end('x'); });
  await assert.rejects(provider.transcribe({ audio: wav() }, signal()), /64 KiB/);
});
