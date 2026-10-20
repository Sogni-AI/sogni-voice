# sogni-voice for Linux + NVIDIA. Verified on a DGX Spark (GB10, aarch64,
# driver 580, CUDA 13). One image runs the API (Node) and, as separate compose
# services, the vLLM-Omni servers for Fish S2 Pro and Fish Drama 3.
# See docs/linux-nvidia.md; build and run through docker/nvidia/compose.yaml.
FROM nvidia/cuda:13.0.1-devel-ubuntu24.04@sha256:7d2f6a8c2071d911524f95061a0db363e24d27aa51ec831fcccf9e76eb72bc92

ARG NODE_VERSION=22.22.0
ARG UV_VERSION=0.13.3
# uv picks PyTorch builds from the host's NVIDIA driver, which a build cannot
# see; this is the DGX Spark's (it resolves torch 2.13.0+cu132).
ARG CUDA_DRIVER_VERSION=580.178.04
# Last vLLM-Omni commit aligned with vLLM 0.31 (its main moved to vLLM 0.32 on
# 2026-10-19). It carries its own Fish S2 Pro and Drama 3 code, including the
# DAC codec, so the fish-speech package (which pins pydantic 2.9) is not needed.
ARG VLLM_OMNI_COMMIT=03c334818305d3b1666da01cd0f67d48a4f3e7a2

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    VIRTUAL_ENV=/app/.venv \
    PATH=/app/.venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.12 python3.12-venv python3.12-dev build-essential git curl ca-certificates \
      xz-utils ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
       | tar -xJ -C /usr/local --strip-components=1 \
    && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

# The services spawn Python daemons from ./.venv, as on macOS.
# requirements.lock is the exact set verified on a DGX Spark: vllm 0.31.0 with
# torch 2.13.0+cu132, vLLM-Omni's dependencies, pocket-tts, and librosa for
# transformers' Parakeet feature extractor. To change it, install
# "vllm==<version>" (--torch-backend=auto), vLLM-Omni, pocket-tts, scipy,
# soundfile and librosa in a fresh image, verify, then
# `uv pip freeze --exclude-editable > docker/nvidia/requirements.lock`.
COPY docker/nvidia/requirements.lock /opt/requirements.lock
RUN uv venv /app/.venv --python /usr/bin/python3.12 \
    && UV_CUDA_DRIVER_VERSION="${CUDA_DRIVER_VERSION}" \
       uv pip install -r /opt/requirements.lock --torch-backend=auto \
    && git clone https://github.com/vllm-project/vllm-omni.git /opt/vllm-omni \
    && git -C /opt/vllm-omni checkout "${VLLM_OMNI_COMMIT}" \
    && uv pip install --no-deps -e /opt/vllm-omni

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "src/index.js"]
