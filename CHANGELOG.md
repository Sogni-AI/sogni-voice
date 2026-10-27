# Changelog

## 2026-10-27

- Preserve continuous Drama 3 TensorFold replies through 2,400 characters and
  use engine-managed segmentation for longer scripts. Increase the generation
  budget to 4,096 frames and enable bounded, seeded silence redraws with a client
  deadline. Preserve completion metadata so clients can withhold unfinished takes.

## 2026-10-23

- Support the pruned Drama 3 NVFP4 checkpoint through native MLX on Apple Silicon
  and the pinned TensorFold engine on DGX Spark, using the existing Fish voice
  references and clone endpoints.
- Add an original/NVFP4 checkpoint choice to Mac setup and a TensorFold Docker
  Compose overlay. Keep the original Drama 3 and S2 backends available.
- Report capped or stalled TensorFold audio with completion metadata; keep the
  audio playable and warn in the demo. Show only supported speaker controls.
