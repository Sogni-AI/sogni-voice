const MIN_OVERLAP_SECONDS = 0.05;

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

/**
 * For each transcript segment, find the diarization turn with the largest
 * overlap and stamp its speaker on the segment. Segments with overlap below
 * MIN_OVERLAP_SECONDS get speaker=null.
 *
 * Inputs are not mutated.
 */
export function mergeSpeakers(segments, turns) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  if (!Array.isArray(turns) || turns.length === 0) {
    return segments.map((s) => ({ ...s, speaker: null }));
  }

  return segments.map((segment) => {
    let bestSpeaker = null;
    let bestOverlap = 0;
    for (const turn of turns) {
      const ov = overlapSeconds(segment.start, segment.end, turn.start, turn.end);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        bestSpeaker = turn.speaker;
      }
    }
    return {
      ...segment,
      speaker: bestOverlap >= MIN_OVERLAP_SECONDS ? bestSpeaker : null,
    };
  });
}

/**
 * Build per-speaker summary from speaker-tagged segments.
 * Sorted by descending totalSeconds.
 */
export function summarizeSpeakers(taggedSegments) {
  if (!Array.isArray(taggedSegments) || taggedSegments.length === 0) return [];

  const acc = new Map();
  for (const seg of taggedSegments) {
    if (!seg.speaker) continue;
    const cur = acc.get(seg.speaker) || { speaker: seg.speaker, segmentCount: 0, totalSeconds: 0 };
    cur.segmentCount += 1;
    cur.totalSeconds += Math.max(0, seg.end - seg.start);
    acc.set(seg.speaker, cur);
  }

  return Array.from(acc.values())
    .map((s) => ({ ...s, totalSeconds: Number(s.totalSeconds.toFixed(2)) }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
}
