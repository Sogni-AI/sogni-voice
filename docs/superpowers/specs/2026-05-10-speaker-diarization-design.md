# Speaker Diarization for /transcribe

## Goal

Add optional speaker diarization to the `/transcribe` endpoint so transcripts
can attribute each segment to a specific speaker (e.g. `SPEAKER_00`,
`SPEAKER_01`). Reuses the existing upload/validation/security work.

## Non-goals

- Persistent speaker embeddings across recordings (re-identifying "Alice"
  across uploads).
- Real-time / streaming diarization.
- Inline rename of speaker labels in the demo UI.

## Architecture

A new Python daemon (`scripts/diarize_daemon.py`) loads
`pyannote/speaker-diarization-3.1` once and stays resident, mirroring the
existing Parakeet pattern. A new Node service
(`src/services/diarization.js`) wraps it via the same JSON-line protocol,
request-id matching, lazy initialization, and graceful shutdown.

When `/transcribe?diarize=true` is called, both daemons read the same temp
file in parallel via `Promise.allSettled`. Total wall-clock ≈
`max(transcribe, diarize)`. A pure merge function decorates each
transcript segment with the dominant speaker by max overlap.

```
upload → temp file → validate (existing) ──┬─→ Parakeet (transcript + timestamps)
                                           └─→ pyannote   (speaker turns [{start,end,speaker}])
                              await Promise.allSettled → mergeSpeakers() → response
```

### Failure isolation

If diarization fails (model unavailable, HF token missing, daemon crash),
the route still returns a successful transcript with
`diarization: { available: false, error: "..." }` and no `speaker` fields.
A flaky diarizer never breaks transcription.

## API

### Request (additions to `/transcribe`)

| Field          | Type    | Notes                                                              |
|----------------|---------|--------------------------------------------------------------------|
| `diarize`      | string  | `"true"` to enable.                                                |
| `numSpeakers`  | integer | Optional exact count. 1–20.                                        |
| `minSpeakers`  | integer | Optional lower bound. 1–20.                                        |
| `maxSpeakers`  | integer | Optional upper bound. 1–20.                                        |

`numSpeakers` and `min`/`max` may both be sent; the daemon prefers
`numSpeakers` when present.

### Response (when `diarize=true`)

```json
{
  "success": true,
  "transcript": "...",
  "timestamps": [
    { "start": 0.0, "end": 3.2, "text": "Hello there.", "speaker": "SPEAKER_00" },
    { "start": 3.4, "end": 6.1, "text": "Hi, how are you?", "speaker": "SPEAKER_01" }
  ],
  "speakers": [
    { "speaker": "SPEAKER_00", "segmentCount": 12, "totalSeconds": 45.3 },
    { "speaker": "SPEAKER_01", "segmentCount": 8,  "totalSeconds": 28.7 }
  ],
  "diarization": { "available": true, "numSpeakers": 2 }
}
```

When `wordTimestamps=true`, word segments inherit the speaker of the
overlapping turn.

When diarization is unavailable or fails:

```json
{
  "success": true,
  "transcript": "...",
  "diarization": {
    "available": false,
    "error": "Diarization is disabled on this server"
  }
}
```

The endpoint never returns 4xx/5xx for diarization-only failures.

## Daemon protocol (`scripts/diarize_daemon.py`)

Identical pattern to `parakeet_daemon.py`:

- Input (one JSON per line on stdin):
  `{"id": "req-N", "audio_path": "/tmp/...", "num_speakers": null, "min_speakers": null, "max_speakers": null}`
- Output (one JSON per line on stdout):
  `{"id": "req-N", "success": true, "turns": [{"start":0.0,"end":3.2,"speaker":"SPEAKER_00"}], "num_speakers": 2}`
- Ready: `{"status":"ready"}`
- Shutdown command + ack as in Parakeet.

Startup: `Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=os.environ["HF_TOKEN"])`. Move to MPS when
`torch.backends.mps.is_available()`.

Missing `HF_TOKEN` → emit `{"status":"error","error":"HF_TOKEN required.
Get one at https://hf.co/settings/tokens and accept the model license at
https://hf.co/pyannote/speaker-diarization-3.1"}` and exit non-zero.

## Configuration (`src/config/index.js`)

```js
diarization: {
  enabled: parseEnvBool(process.env.DIARIZATION_ENABLED, false),
  hfToken: process.env.HF_TOKEN || null,
  timeout: parseInt(process.env.DIARIZATION_TIMEOUT, 10) || 600000,
  daemonStartupTimeout: parseInt(process.env.DIARIZATION_DAEMON_STARTUP_TIMEOUT, 10) || 180000,
  preWarmDaemon: false,
}
```

## Files

| File                                              | Status   | Purpose                                            |
|---------------------------------------------------|----------|----------------------------------------------------|
| `scripts/diarize_daemon.py`                       | new      | pyannote daemon                                    |
| `src/services/diarization.js`                     | new      | Node singleton wrapper                             |
| `src/utils/diarizationMerge.js`                   | new      | `mergeSpeakers`, `summarizeSpeakers`               |
| `src/utils/errors.js`                             | modified | add `DiarizationError`                             |
| `src/config/index.js`                             | modified | add `diarization` block                            |
| `src/routes/transcribe.js`                        | modified | Joi additions, parallel call, merge, response      |
| `src/index.js`                                    | modified | register `diarizationService.shutdown` in shutdown |
| `public/index.html`                               | modified | "Identify speakers" checkbox + colored chips       |
| `requirements-diarization.txt`                    | new      | optional pip deps (pyannote.audio, torch, etc.)    |
| `tests/unit/utils/diarizationMerge.test.js`       | new      | merge logic                                        |
| `tests/integration/transcribe.test.js`            | modified | mocked diarize success + failure cases             |

## Demo UI

In **1. Voice Recording to Text**:

- Add `Identify speakers` checkbox alongside the timestamp dropdown. Only
  enabled when timestamp mode is `sentence` or `word` (per-segment labels
  need segments).
- When checked, request includes `diarize=true`.
- Each timestamp line gets a colored chip rendered with `textContent`
  before the text: `[SPEAKER_00] Hello there.` Color picked from a small
  palette indexed by speaker number.
- Summary line below the result: `Speakers detected: 2 (SPEAKER_00, SPEAKER_01)`.
- If `diarization.available === false`, render the transcript normally and
  show an inline note: `Speaker identification unavailable: <reason>`.

## Testing

- `tests/unit/utils/diarizationMerge.test.js` — single speaker, two
  speakers with clean turns, overlapping turns (max IoU wins), segment
  fully inside one turn, segment spanning two turns, no-overlap silence
  segment, empty turns list, empty segments list.
- `tests/integration/transcribe.test.js` — `diarize=true` with mocked
  `diarizationService.diarize` returning two-speaker turns →
  speaker-decorated response. Mocked failure → response retains transcript
  with `diarization.available: false`.
- No live model test (pyannote requires HF token + ~1GB download).

## Out of scope (future work)

- Inline speaker rename in the demo UI (`SPEAKER_00` → `Alice`).
- Persistent speaker identification across recordings.
- Real-time / streaming diarization.
- Auto-installing pyannote dependencies — kept in a separate
  `requirements-diarization.txt` so non-diarization deployments stay lean.
