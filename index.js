import Schema from '@deepseek-ai/schemastery';
import { createProvider } from './provider.js';

export const inject = ['speechToText'];
export const Config = Schema.object({
  asr: Schema.object({
    enabled: Schema.boolean().default(false).description('Enable the optional compatible ASR adapter'),
    protocol: Schema.union(['compatible', 'deepgram']).default('compatible').description('Request protocol: OpenAI-style multipart (compatible) or Deepgram /v1/listen'),
    endpoint: Schema.string().default('').description('Complete server-side transcription endpoint (optional for deepgram; defaults to api.deepgram.com)'),
    model: Schema.string().default('').description('Model accepted by the configured server (deepgram defaults to nova-3)'),
    apiKey: Schema.string().role('secret').default('').description('Server-side credential: Bearer token (compatible, optional) or Deepgram API key (required)'),
    hostHeader: Schema.string().default('').description('Optional trusted gateway Host header override'),
    timeoutMs: Schema.number().min(50).max(300000).step(1).default(180000).description('Request timeout in milliseconds'),
    providerId: Schema.string().min(1).default('dsh-dictation-compatible'),
    providerName: Schema.string().min(1).default('Compatible ASR'),
    languages: Schema.array(Schema.string().min(1)).min(1).default(['auto']),
    advancedMode: Schema.boolean().default(false).description('Enable advanced segmented dictation and recovery panel'),
  }).default({}).volatile().description('Optional server-side compatible ASR settings'),
});

// Validation is completed before touching the active registration. Do not echo
// endpoint/auth values or an upstream validation error into remotely visible logs.
function validate(options) {
  if (!options.enabled) return null;
  try {
    const snapshot = { ...options, languages: [...options.languages] };
    const provider = createProvider(snapshot);
    return { provider, identity: JSON.stringify([provider.info.id, provider.info.name, provider.info.languages]) };
  } catch {
    throw new Error('Invalid ASR settings: check endpoint, model, credential, Host, timeout and provider metadata');
  }
}

export async function apply(ctx, config) {
  let disposed = false;
  let registration = null;
  let current = null;
  let pending = Promise.resolve();

  async function commit(next) {
    if (disposed) return;
    if (registration && next?.identity === registration.identity) {
      // Requests already admitted captured the previous provider object. Updating
      // transport/auth settings affects only subsequent requests, without unload.
      current = next.provider;
      return;
    }
    const previous = registration;
    registration = null;
    current = null;
    if (previous) await previous.dispose();
    if (disposed || !next) return;
    current = next.provider;
    const wrapper = {
      info: next.provider.info,
      transcribe(input, signal) {
        const selected = current;
        if (!selected) throw new Error('ASR adapter is not available');
        return selected.transcribe(input, signal);
      },
    };
    try {
      const dispose = ctx.speechToText.register(wrapper);
      registration = { dispose, identity: next.identity };
    } catch (error) {
      current = null;
      throw error;
    }
  }
  function update(options) {
    if (disposed) return Promise.reject(new Error('ASR adapter is stopped'));
    const next = validate(options);
    // Continue accepting a corrected configuration after an earlier rejection;
    // the rejected update itself is still returned to its caller, not hidden.
    pending = pending.catch(() => {}).then(() => commit(next));
    return pending;
  }
  ctx.effect(() => async () => {
    disposed = true;
    await pending.catch(() => {});
    const previous = registration;
    registration = null;
    current = null;
    if (previous) await previous.dispose();
  });
  ctx.on('internal/update', candidate => update(candidate.asr.get()));
  await update(config.asr.get());
}
