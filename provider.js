import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const SAFE_ERROR = Symbol('sanitized ASR error');
const MAX_AUDIO_SECONDS = 120;
const MAX_RESPONSE_BYTES = 65536;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LANGUAGE = /^(?:auto|[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)$/;

function failure(message, { status, retryable = false, name = 'Error' } = {}) {
  const error = new Error(message);
  Object.defineProperty(error, SAFE_ERROR, { value: true });
  error.name = name;
  error.retryable = retryable;
  if (status !== undefined) error.status = status;
  return error;
}
function cancelled() { return failure('ASR request cancelled', { name: 'AbortError' }); }

function configuration(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('Invalid ASR configuration');
  const { endpoint, model, apiKey = '', hostHeader = '', timeoutMs = 180000,
    providerId = 'dsh-dictation-compatible', providerName = 'Compatible ASR', languages = ['auto'] } = config;
  let url;
  try {
    if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint) || endpoint !== endpoint.trim() || CONTROL.test(endpoint) || /[?#]/.test(endpoint) || /^https?:\/\/[^/]*@/i.test(endpoint)) throw null;
    url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw null;
  } catch { throw failure('ASR endpoint must be a full HTTP(S) URL without credentials, query or fragment'); }
  if (typeof model !== 'string' || !model.trim() || [...model].length > 128 || CONTROL.test(model)) throw failure('Invalid ASR model');
  if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[^\x20-\x7e]/.test(apiKey)) throw failure('Invalid ASR API key');
  if (typeof hostHeader !== 'string' || hostHeader.length > 300) throw failure('Invalid ASR Host header');
  if (hostHeader) {
    try {
      if (!/^[a-zA-Z0-9.:[\]-]+$/.test(hostHeader) || hostHeader.endsWith(':')) throw null;
      const authority = new URL('http://' + hostHeader);
      const hostname = authority.hostname.replace(/^\[|\]$/g, '');
      if (!isIP(hostname) && (hostname.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/.test(hostname))) throw null;
      if (authority.pathname !== '/' || authority.username || authority.password || authority.search || authority.hash) throw null;
    } catch { throw failure('Invalid ASR Host header'); }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 300000) throw failure('ASR timeout must be 50–300000 milliseconds');
  if (typeof providerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerId)) throw failure('Invalid ASR provider identifier');
  if (typeof providerName !== 'string' || !providerName.trim() || [...providerName].length > 128 || CONTROL.test(providerName)) throw failure('Invalid ASR provider name');
  if (!Array.isArray(languages) || !languages.length || languages.length > 32 || new Set(languages).size !== languages.length || languages.some(language => typeof language !== 'string' || language.length > 32 || !LANGUAGE.test(language))) throw failure('Invalid ASR languages');
  return { url, model, apiKey, hostHeader, timeoutMs, providerId, providerName, languages: [...languages] };
}

function audioDuration(audio) {
  if (!(audio instanceof Uint8Array)) throw failure('Audio must be canonical 16 kHz mono PCM16 WAV');
  if (audio.byteLength > 44 + MAX_AUDIO_SECONDS * 32000) throw failure('Audio exceeds 120 seconds');
  const bytes = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (bytes.length < 46 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000
    || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16
    || bytes.toString('ascii', 36, 40) !== 'data'
    || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.readUInt32LE(40) !== bytes.length - 44
    || (bytes.length - 44) % 2) throw failure('Audio must be canonical 16 kHz mono PCM16 WAV');
  return (bytes.length - 44) / 32000;
}

function multipart(audio, model, language) {
  const boundary = `dsh-dictation-${randomUUID()}`;
  const parts = [];
  for (const [name, value] of Object.entries({ model, response_format: 'json', ...(language === 'auto' ? {} : { language }) })) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

function post(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    // Node's direct request never follows redirects and retains normal TLS validation.
    const tls = url.protocol === 'https:' ? { servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? '' : url.hostname } : {};
    const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers, signal, ...tls }, response => {
      const status = response.statusCode;
      // Do not read or expose diagnostic bodies, redirect destinations or headers.
      if (status !== 200) {
        reject(failure(`ASR returned HTTP ${status}`, { status, retryable: [408, 425, 429].includes(status) || status >= 500 }));
        response.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          reject(failure('ASR response exceeds 64 KiB'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', () => reject(failure('ASR network request failed', { retryable: true })));
      response.on('aborted', () => reject(failure('ASR network response interrupted', { retryable: true })));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', () => reject(failure('ASR network request failed', { retryable: true })));
    request.end(body);
  });
}

/** Administrator-configured adapter. Never pass its configuration to browser slots. */
export function createProvider(config) {
  const { url, model, apiKey, hostHeader, timeoutMs, providerId, providerName, languages } = configuration(config);
  return {
    info: Object.freeze({ id: providerId, name: providerName, location: 'cloud', languages: Object.freeze([...languages]) }),
    async transcribe({ audio, language = 'auto' }, signal) {
      if (signal?.aborted) throw cancelled();
      if (!languages.includes(language)) throw failure('Unsupported ASR language');
      const audioSeconds = audioDuration(audio);
      const { boundary, body } = multipart(audio, model, language);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      timer.unref?.();
      const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const started = performance.now();
      try {
        const response = await post(url, {
          ...(hostHeader ? { Host: hostHeader } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length), Accept: 'application/json',
        }, body, combined);
        let result;
        try { result = JSON.parse(response); } catch { throw failure('ASR returned invalid JSON'); }
        if (typeof result?.text !== 'string') throw failure('ASR response is missing transcription text');
        if (combined.aborted) throw cancelled();
        return { text: result.text.trim(), audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 };
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (timeout.signal.aborted) throw failure('ASR request timed out', { retryable: true });
        throw error?.[SAFE_ERROR] ? error : failure('ASR network request failed', { retryable: true });
      } finally { clearTimeout(timer); }
    },
  };
}
