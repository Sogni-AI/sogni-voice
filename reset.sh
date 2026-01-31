#!/bin/bash

set -e

RESET_TARGETS=(
  ".env"
  ".env.backup."*
  ".venv"
  "node_modules"
  "models"
)

echo "This will remove local install artifacts so you can simulate a fresh install:"
for target in "${RESET_TARGETS[@]}"; do
  echo "  - ${target}"
done

echo ""
read -r -p "Proceed? (y/N): " confirm

case "$confirm" in
  y|Y)
    for target in "${RESET_TARGETS[@]}"; do
      rm -rf ${target}
    done
    echo "Reset complete."
    ;;
  *)
    echo "Canceled."
    ;;
esac
