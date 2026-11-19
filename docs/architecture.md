# Architecture, Durability & Development

Target verified DSH version: **0.2.2-rc.1** (tested on Node.js 24).

## Capture & Durability

- **Audio format**: Continuous capture converts microphone input to 16 kHz, mono, PCM16 WAV (`AudioWorklet`), splitting around ~28s at silence (or at most ~30s during continuous speech) in segmented capture.
- **IndexedDB-first**: Segments are committed to browser IndexedDB (`dsh-dictation`) before serial transcription. Transient errors retry up to 3 times with exponential backoff; failed chunks retain audio and block subsequent chunks in the same recording until retried or deleted.
- **Checkpoints**: While recording, the active tail is checkpointed roughly every 1s so an unexpected crash loses at most ~1s of recent audio (subject to browser/OS sleep behavior).
- **Multi-tab coordination**: Same-origin tabs coordinate via Web Locks (`dsh-dictation-worker-v1`). Idle tabs cooperatively hand over ownership; tabs actively recording or saving refuse takeover.
- **Draft safety**: Recognized text is inserted into the current message draft and never sent automatically. Draft edits during dictation pause auto-insertion without losing recognized text.

## Privacy & Storage

- Audio is sent from the browser to your configured DSH server, which forwards it to the configured ASR backend (which may be a third-party service). Deployers are responsible for informing users about data recipients and retention policies.
- Recorded audio and transcripts are stored unencrypted in browser IndexedDB and are not auto-deleted. Users can export or delete recordings in Advanced Mode; clearing site data removes local recordings.
- See [SECURITY.md](../SECURITY.md) for security details.

## Local Development & Verification

Requirements: Node.js >= 22 (CI uses Node 24), npm, and Chromium (for Playwright tests). Browser tests use synthetic audio and a simulated ASR server.

```bash
npm ci --ignore-scripts
npm test
npx playwright install chromium
npm run test:browser
npm run build
node scripts/check-public.mjs
npm pack --dry-run --ignore-scripts
```
