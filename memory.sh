#!/bin/bash
#
# memory.sh - Sogni Transcribe Project Context Generator
#
# Generates a complete project snapshot for LLM context.
# Copies all source files with headers to clipboard for one-shot improvements.
#
set -euo pipefail

# Create a temporary file for concatenated content
temp_file=$(mktemp)

cat << 'PROJECT_OVERVIEW' >> "$temp_file"
# SOGNI TRANSCRIBE - Project Overview

## What This Is
REST API for audio transcription (STT) and text-to-speech (TTS) synthesis.
Built for Apple Silicon Macs using MLX for ML acceleration.

## Tech Stack
- **Framework**: Hapi.js (ES modules)
- **TTS**: kokoro-js library (ONNX model, ~300MB on first use)
- **Transcription**: parakeet-mlx via `uvx` CLI (requires Python uvx)
- **Validation**: Joi
- **Testing**: Vitest

## API Endpoints
| Method | Path          | Description                        |
|--------|---------------|------------------------------------|
| POST   | /transcribe   | Upload audio file → get transcript |
| POST   | /tts          | Send text → get WAV audio          |
| GET    | /tts/voices   | List available TTS voices          |
| GET    | /health       | Health check                       |

## Key Architecture
- Entry: src/index.js → src/server.js (createServer/initServer/startServer)
- Routes: src/routes/*.js aggregated in src/routes/index.js
- Services: Singleton pattern with lazy initialization
- Errors: Custom errors with toBoom() for Hapi responses
- Config: Environment variables via src/config/index.js

## Commands
```bash
npm run dev          # Hot reload development
npm test             # Run tests (watch mode)
npm run test:run     # Run tests once
npm run pm2:start    # Production with PM2
```

## External Dependencies
- ffmpeg (audio processing)
- Python uvx (for parakeet-mlx CLI)

---
PROJECT_OVERVIEW

echo "Listing and concatenating files (excluding node_modules, tests, and package-lock.json)..."
total_bytes=0

while IFS= read -r file; do
    size_bytes=$(wc -c < "$file" | tr -d ' ')
    size_kb=$(( (size_bytes + 1023) / 1024 ))
    if [ "$size_bytes" -gt 204800 ]; then
      color="\033[31m"  # red
      echo -e "${color}### $file (too large: ${size_kb} KB), skipping\033[0m"
    else
      if [ "$size_kb" -gt 50 ]; then
        color="\033[31m"  # red
      elif [ "$size_kb" -gt 10 ]; then
        color="\033[33m"  # yellow
      else
        color=""
      fi
      if [ -n "$color" ]; then
        echo -e "${color}### $file (${size_kb} KB)\033[0m"
      else
        echo "### $file (${size_kb} KB)"
      fi
      total_bytes=$((total_bytes + size_bytes))
      {
        echo -e "\n### $file\n"
        cat "$file"
        echo
      } >> "$temp_file"
    fi
done < <(find . \
  -type f \
  ! -path "*/node_modules/*" \
  ! -path "*/tests/*" \
  ! -path "*/.git/*" \
  ! -path "*/coverage/*" \
  ! -name "package-lock.json" \
  ! -name "*.log" \
  ! -name ".DS_Store" \
  \( -name "*.js" -o -name "*.json" -o -name "*.md" -o -name "*.cjs" \) \
  | sort)

echo "Copying concatenated content to clipboard..."
pbcopy < "$temp_file"

# Clean up
rm "$temp_file"

total_kb=$(( (total_bytes + 1023) / 1024 ))
echo ""
echo "All file contents (with labels) have been copied to the clipboard!"
echo "Total file size copied: ${total_kb} KB"
echo ""
echo "Tip: Paste into an LLM with a prompt like:"
echo "  'Review this codebase and suggest improvements for [specific area]'"
