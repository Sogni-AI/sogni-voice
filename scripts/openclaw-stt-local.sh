#!/usr/bin/env bash
set -euo pipefail
if [ $# -lt 1 ]; then
  echo "Usage: $0 <audio-file>" >&2
  exit 2
fi
AUDIO="$1"
curl -sS -X POST http://localhost:3000/transcribe -F "file=@${AUDIO}"
