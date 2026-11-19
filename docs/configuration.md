# Configuration Reference

By default `asr.enabled` is `false`, so the plugin uses DSH's existing default `speech` provider. Administrators can configure `asr.*` directly in DSH **Plugins → Durable dictation** (or via `ui-dictation` row configuration).

When `asr.enabled` is `true`, the plugin automatically prefers its own configured `asr.providerId` unless overridden per-browser in Advanced Mode.

## Fields

| Field | Default | Description |
| --- | --- | --- |
| `asr.enabled` | `false` | Register the server-side ASR adapter. |
| `asr.protocol` | `compatible` | Request protocol: `compatible` (multipart + JSON `text`) or `deepgram` (`/v1/listen`). |
| `asr.endpoint` | `""` | Full HTTP(S) transcription URL (no credentials, query, or fragment). Defaults to `https://api.deepgram.com/v1/listen` when `protocol` is `deepgram`. |
| `asr.model` | `""` | Model identifier accepted by the backend. Defaults to `nova-3` when `protocol` is `deepgram`. |
| `asr.apiKey` | `""` | Optional Bearer token (`compatible`), or required API key sent with `Authorization: Token <key>` (`deepgram`). Marked `secret` in schema and redacted on remote reads. |
| `asr.hostHeader` | `""` | Optional trusted gateway `Host` header override (does not alter connection target or TLS SNI). |
| `asr.timeoutMs` | `180000` | Per-request timeout in milliseconds (integer `50`–`300000`). |
| `asr.providerId` | `dsh-dictation-compatible` | Unique provider ID registered in the DSH `speech` catalog. |
| `asr.providerName` | `Compatible ASR` | Display name shown in the speech catalog. |
| `asr.languages` | `["auto"]` | 1–32 unique language codes (`auto`, `multi`, or BCP-47 tags). |
| `asr.advancedMode` | `false` | Enables the right-click/long-press recovery panel, provider/language/mic selectors, and recording history. |

## OpenAI-Compatible Example

```json
{
  "asr": {
    "enabled": true,
    "protocol": "compatible",
    "endpoint": "https://asr.example.com/v1/audio/transcriptions",
    "model": "your-model"
  }
}
```

## Deepgram Example

Setting `asr.protocol` to `deepgram` uses Deepgram's prerecorded endpoint (`POST /v1/listen`): raw 16 kHz mono PCM16 WAV body, `Authorization: Token <apiKey>`, `smart_format=true`, and `model`/`language` query parameters. Minimal configuration only requires `apiKey`:

```json
{
  "asr": {
    "enabled": true,
    "protocol": "deepgram",
    "apiKey": "...",
    "providerId": "dsh-dictation-deepgram",
    "providerName": "Deepgram",
    "languages": ["auto", "zh", "en"]
  }
}
```

- `auto` maps to `language=multi` (measured to transcribe both English and Mandarin on `nova-3`, whereas `detect_language` returned empty transcripts for Mandarin).
- Explicit language codes (e.g. `zh`, `en`, `multi`) are forwarded as-is.

## Hot-Reload Behavior

Saving changes in the Plugin Manager UI updates `cordis.patch.yml` and hot-reloads the adapter:
- Changing `endpoint`, `model`, `apiKey`, `hostHeader`, or `timeoutMs` with the same `providerId`, `providerName`, and `languages` applies to subsequent requests immediately without unregistering.
- Changing `enabled`, `providerId`, `providerName`, or `languages` unregisters the previous provider (waiting for in-flight work) before registering the new one.
