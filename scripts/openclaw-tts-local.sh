#!/usr/bin/env bash
set -euo pipefail
if [ $# -lt 2 ]; then
  echo "Usage: $0 <text> <output-wav>" >&2
  exit 2
fi
TEXT="$1"
OUT="$2"
curl -sS -X POST http://localhost:3000/pocket-tts \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"${TEXT}\",\"voice\":\"alba\",\"format\":\"wav\"}" \
  -o "${OUT}"
echo "${OUT}"
