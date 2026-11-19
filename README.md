# @xieyuschen/dsh-dictation

Durable, backend-independent voice dictation plugin for DeepSeek Harness (DSH). Records audio locally into IndexedDB, transcribes via DSH's `speech` service (or an optional built-in OpenAI-compatible / Deepgram adapter), and inserts text into the message draft without ever sending automatically.

## Features

- **Simple click-to-record default**: Click the microphone button to start, click again to stop and immediately transcribe into your draft.
- **Durable local buffering**: Audio is persisted in IndexedDB before upload, with bounded retries on transient failures.
- **Optional Advanced Mode**: Enable in plugin settings to unlock ~28–30s automatic segmentation, multi-tab Web Locks handover, provider/language/mic selection, and recording recovery/export via right-click or long-press.
- **Built-in Plugin Manager UI**: Configure OpenAI-compatible ASR endpoints or Deepgram (`/v1/listen`) directly from DSH **Plugins → Durable dictation**.

## Installation

1. Open **Plugins → Add plugin** in DeepSeek Harness.
2. Enter `@xieyuschen/dsh-dictation` and install.
3. Enable the plugin and reload open browser tabs.

## Configuration

Open **Plugins → Installed plugins → Durable dictation** in DSH to configure:

- **Enable Compatible ASR Adapter**: Register the plugin's server-side ASR provider in DSH's `speech` catalog.
- **Protocol**: Choose `compatible` (OpenAI-compatible `multipart/form-data` `/v1/audio/transcriptions`) or `deepgram` (`POST /v1/listen`).
- **Endpoint / Model / API Key**: For `deepgram`, only `apiKey` is required (`endpoint` defaults to `https://api.deepgram.com/v1/listen` and `model` defaults to `nova-3`).
- **Advanced Mode**: Off by default for simple one-click start/stop dictation; turn on to enable segmented recording and the right-click/long-press recovery panel.

See [docs/configuration.md](docs/configuration.md) for all configuration fields and protocol details, and [docs/architecture.md](docs/architecture.md) for durability, privacy, and local development notes.

## License

[MIT](LICENSE) — third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
