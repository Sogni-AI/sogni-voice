# Qwen3-TTS Investigation

**Date:** 2026-01-23
**Status:** Research complete, implementation pending
**Goal:** Evaluate Qwen3-TTS for voice cloning to replace/augment current Kokoro TTS

---

## Overview

Qwen3-TTS is a new open-source TTS family from Alibaba/Qwen team, released January 2025. It offers voice cloning, voice design, and high-quality multilingual speech synthesis.

**Official Resources:**
- GitHub: https://github.com/QwenLM/Qwen3-TTS
- HuggingFace: https://huggingface.co/collections/Qwen/qwen3-tts
- Blog: https://qwen.ai/blog?id=qwen3tts-0115
- Paper: https://arxiv.org/html/2601.15621
- Demo: https://huggingface.co/spaces/Qwen/Qwen3-TTS
- API: https://alibabacloud.com/help/en/model-studio/qwen-tts-voice-design

---

## Model Variants

| Model | Parameters | Features | Streaming | Instruction Control |
|-------|------------|----------|-----------|---------------------|
| **1.7B-CustomVoice** | 1.7B | 9 premium timbres, style control | ✅ | ✅ |
| **1.7B-VoiceDesign** | 1.7B | Natural-language voice descriptions | ✅ | ✅ |
| **1.7B-Base** | 1.7B | 3-second rapid voice cloning | ✅ | ❌ |
| **0.6B-CustomVoice** | 0.6B | Lightweight, 9 timbres | ✅ | ❌ |
| **0.6B-Base** | 0.6B | Lightweight cloning model | ✅ | ❌ |

All models use a 12Hz tokenizer for high compression.

---

## Key Features

### Voice Cloning (3-second)
- Clone any voice from just 3 seconds of reference audio
- Reference audio can be: local file path, URL, base64 string, or numpy array
- Optional `x_vector_only_mode=True` extracts speaker embeddings only (faster, lower quality)
- Reusable voice prompts via `create_voice_clone_prompt()` to avoid recomputing

### Voice Design
- Create entirely new voices from natural language descriptions
- Example: "A warm, friendly female voice with a slight British accent"

### Language Support
10 languages: Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian

### Performance
- **First-packet latency:** 97ms (0.6B) / 101ms (1.7B)
- **Real-time factor (RTF):** 0.288 (0.6B) / 0.313 (1.7B)
- Trained on 5+ million hours of speech data

---

## Python API Examples

### Installation
```bash
pip install -U qwen-tts
pip install -U flash-attn --no-build-isolation  # Optional, CUDA only
```

### Basic Generation (CustomVoice)
```python
from qwen_tts import QwenTTS

model = QwenTTS.from_pretrained("Qwen/Qwen3-TTS-1.7B-CustomVoice")
wavs, sr = model.generate_custom_voice(
    text="Hello, how are you today?",
    language="English",
    speaker="Vivian",
    instruct="Speak warmly and friendly"
)
```

### Voice Cloning
```python
wavs, sr = model.generate_voice_clone(
    text="This is my cloned voice speaking.",
    language="English",
    ref_audio="path/to/reference.wav",  # or URL, base64, numpy array
    ref_text="Transcript of the reference audio"  # Optional but improves quality
)
```

### Voice Design
```python
wavs, sr = model.generate_voice_design(
    text="Hello world",
    language="English",
    instruct="A deep, authoritative male voice with American accent"
)
```

---

## Apple Silicon Compatibility

### ⚠️ CRITICAL: No MLX Support

Qwen3-TTS is built on PyTorch with CUDA optimizations:
- Uses `device_map="cuda:0"` by default
- FlashAttention2 recommended (CUDA-only)
- vLLM backend with CUDA Graph acceleration

**This is different from Qwen3 LLM which has MLX support.**

### Comparison with Current Stack

| Feature | Qwen3-TTS | Current Kokoro (mlx-audio) |
|---------|-----------|---------------------------|
| MLX Support | ❌ No | ✅ Native |
| MPS (Metal) | ⚠️ Untested, may work | N/A |
| CUDA | ✅ Primary target | N/A |
| Voice Cloning | ✅ 3-second | ❌ No |
| Voice Design | ✅ From descriptions | ❌ No |
| Model Size | 0.6B-1.7B (~2-6GB) | 82M (~300MB) |
| Languages | 10 | 4 |

### Potential Approaches for Mac

#### Option A: PyTorch MPS Backend (Experimental)
```python
# Modify device mapping
model = QwenTTS.from_pretrained(
    "Qwen/Qwen3-TTS-0.6B-Base",
    device_map="mps"  # Instead of "cuda:0"
)
```
- **Pros:** Local inference, no API costs
- **Cons:** Untested, FlashAttention2 won't work, unknown performance
- **Risk:** May not work or be too slow

#### Option B: CPU Inference
```python
model = QwenTTS.from_pretrained(
    "Qwen/Qwen3-TTS-0.6B-Base",
    device_map="cpu"
)
```
- **Pros:** Will definitely work
- **Cons:** Extremely slow for 0.6B-1.7B models, impractical for real-time

#### Option C: Alibaba Cloud API
- **Endpoint:** https://alibabacloud.com/help/en/model-studio/qwen-tts-voice-cloning
- **Pros:** No local computation, reliable, fast
- **Cons:** API costs, latency, requires internet

#### Option D: Wait for MLX Port
- Qwen3 LLM has MLX support via mlx-lm
- Community may port TTS models
- Timeline unknown (weeks to months)

#### Option E: Hybrid Approach (Recommended)
- Keep Kokoro for standard TTS (fast, MLX-native)
- Use Qwen3-TTS API or MPS for voice cloning only
- Best of both worlds

---

## Integration Plan (When Ready)

### Phase 1: Validate MPS Compatibility
1. Create test script `scripts/qwen_tts_test.py`
2. Install qwen-tts in fresh venv
3. Test with device="mps"
4. Benchmark latency and quality
5. Test voice cloning with 3s reference

### Phase 2: Integration (Based on Phase 1 Results)

**If MPS works:**
- Create `scripts/qwen_tts_daemon.py`
- Add config: `TTS_MODEL=kokoro|qwen3`
- New daemon protocol for voice cloning params

**If MPS too slow:**
- Implement Alibaba Cloud API wrapper
- Voice cloning via API only
- Keep Kokoro for standard TTS

### Phase 3: Voice Training UI
Add to demo homepage:
- Upload/record voice sample (3-30s)
- Process and create voice embedding
- Save to voice library
- Use cloned voice for TTS

### Files to Create/Modify

| File | Purpose |
|------|---------|
| `scripts/qwen_tts_test.py` | MPS compatibility test script |
| `scripts/qwen_tts_daemon.py` | Production daemon (if viable) |
| `src/services/tts.js` | Add model selection, voice cloning methods |
| `src/routes/tts.js` | New endpoints: POST /tts/voices/clone |
| `public/index.html` | Voice training UI |
| `.env.example` | New config: TTS_MODEL, QWEN_API_KEY |

### New API Endpoints (Proposed)

```
POST /tts/voices/clone
  - Upload reference audio
  - Returns voice_id for future use

GET /tts/voices/cloned
  - List user's cloned voices

DELETE /tts/voices/cloned/:id
  - Remove cloned voice

POST /tts (extended)
  - Add: cloned_voice_id parameter
  - Add: voice_sample for inline cloning
```

---

## Test Script Template

Save this to test MPS compatibility when ready:

```python
#!/usr/bin/env python3
"""
Test Qwen3-TTS on Apple Silicon via MPS backend.
Run: python scripts/qwen_tts_test.py
"""

import time
import torch
import soundfile as sf

def test_mps_availability():
    """Check if MPS is available."""
    print(f"PyTorch version: {torch.__version__}")
    print(f"MPS available: {torch.backends.mps.is_available()}")
    print(f"MPS built: {torch.backends.mps.is_built()}")
    return torch.backends.mps.is_available()

def test_qwen_tts():
    """Test Qwen3-TTS with MPS backend."""
    from qwen_tts import QwenTTS

    print("\n--- Loading Model ---")
    start = time.time()

    try:
        # Try MPS first
        model = QwenTTS.from_pretrained(
            "Qwen/Qwen3-TTS-0.6B-Base",
            device_map="mps",
            torch_dtype=torch.float32  # MPS may not support fp16
        )
        device = "mps"
    except Exception as e:
        print(f"MPS failed: {e}")
        print("Falling back to CPU...")
        model = QwenTTS.from_pretrained(
            "Qwen/Qwen3-TTS-0.6B-Base",
            device_map="cpu"
        )
        device = "cpu"

    load_time = time.time() - start
    print(f"Model loaded on {device} in {load_time:.2f}s")

    # Test basic generation
    print("\n--- Basic Generation Test ---")
    start = time.time()
    wavs, sr = model.generate_voice_clone(
        text="Hello, this is a test of Qwen3 TTS on Apple Silicon.",
        language="English",
        ref_audio=None  # Use default voice
    )
    gen_time = time.time() - start
    print(f"Generated in {gen_time:.2f}s")

    # Save output
    sf.write("qwen_test_output.wav", wavs[0], sr)
    print(f"Saved to qwen_test_output.wav")

    # Test voice cloning (if reference audio available)
    # Uncomment when you have reference audio:
    # print("\n--- Voice Cloning Test ---")
    # wavs, sr = model.generate_voice_clone(
    #     text="This is my cloned voice.",
    #     language="English",
    #     ref_audio="path/to/3second_sample.wav",
    #     ref_text="Transcript of the sample"
    # )

    return {
        "device": device,
        "load_time": load_time,
        "gen_time": gen_time
    }

if __name__ == "__main__":
    if test_mps_availability():
        results = test_qwen_tts()
        print(f"\n--- Results ---")
        print(f"Device: {results['device']}")
        print(f"Load time: {results['load_time']:.2f}s")
        print(f"Generation time: {results['gen_time']:.2f}s")
    else:
        print("MPS not available on this system")
```

---

## Open Questions (To Decide Later)

1. **API Fallback:** If MPS doesn't work well, use Alibaba Cloud API?
2. **Voice Storage:** Local filesystem vs database for multi-user?
3. **Demo Scope:**
   - Upload voice sample?
   - Save multiple voices?
   - Voice preview before saving?
   - Voice descriptions/naming?

---

## References

- [Qwen3-TTS GitHub](https://github.com/QwenLM/Qwen3-TTS)
- [Qwen3-TTS Paper](https://arxiv.org/html/2601.15621)
- [Alibaba Cloud TTS API](https://alibabacloud.com/help/en/model-studio/qwen-tts-voice-cloning)
- [PyTorch MPS Backend](https://pytorch.org/docs/stable/notes/mps.html)
- [MLX Framework](https://github.com/ml-explore/mlx)

---

*Last updated: 2026-01-23*
