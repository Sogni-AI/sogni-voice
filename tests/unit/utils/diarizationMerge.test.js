import { describe, it, expect } from 'vitest';
import { mergeSpeakers, summarizeSpeakers } from '../../../src/utils/diarizationMerge.js';

describe('mergeSpeakers', () => {
  it('returns empty array for empty segments', () => {
    expect(mergeSpeakers([], [{ start: 0, end: 1, speaker: 'SPEAKER_00' }])).toEqual([]);
  });

  it('marks all segments speaker=null when turns is empty', () => {
    const segs = [{ start: 0, end: 1, text: 'hi' }];
    expect(mergeSpeakers(segs, [])).toEqual([{ start: 0, end: 1, text: 'hi', speaker: null }]);
  });

  it('attributes a single-speaker conversation correctly', () => {
    const segs = [
      { start: 0, end: 2, text: 'hello' },
      { start: 2, end: 4, text: 'world' },
    ];
    const turns = [{ start: 0, end: 4, speaker: 'SPEAKER_00' }];
    const out = mergeSpeakers(segs, turns);
    expect(out.every((s) => s.speaker === 'SPEAKER_00')).toBe(true);
  });

  it('picks the dominant speaker by max overlap when a segment spans two turns', () => {
    const segs = [{ start: 1.0, end: 3.0, text: 'mixed' }];
    const turns = [
      { start: 0.0, end: 1.4, speaker: 'SPEAKER_00' },
      { start: 1.4, end: 5.0, speaker: 'SPEAKER_01' },
    ];
    const out = mergeSpeakers(segs, turns);
    expect(out[0].speaker).toBe('SPEAKER_01');
  });

  it('attributes a segment fully inside one turn', () => {
    const segs = [{ start: 1.5, end: 2.0, text: 'short' }];
    const turns = [
      { start: 0.0, end: 1.0, speaker: 'SPEAKER_00' },
      { start: 1.0, end: 5.0, speaker: 'SPEAKER_01' },
    ];
    expect(mergeSpeakers(segs, turns)[0].speaker).toBe('SPEAKER_01');
  });

  it('marks no-overlap (silence) segments as null', () => {
    const segs = [{ start: 10, end: 11, text: 'detached' }];
    const turns = [{ start: 0, end: 1, speaker: 'SPEAKER_00' }];
    expect(mergeSpeakers(segs, turns)[0].speaker).toBe(null);
  });

  it('marks below-threshold overlap as null (e.g. 20ms)', () => {
    const segs = [{ start: 0.98, end: 2.0, text: 'edge' }];
    const turns = [
      { start: 0.0, end: 1.0, speaker: 'SPEAKER_00' },  // 20ms overlap
      { start: 5.0, end: 6.0, speaker: 'SPEAKER_01' },  // 0ms overlap
    ];
    expect(mergeSpeakers(segs, turns)[0].speaker).toBe(null);
  });

  it('handles two clean alternating speakers', () => {
    const segs = [
      { start: 0.0, end: 2.0, text: 'a1' },
      { start: 2.5, end: 4.0, text: 'b1' },
      { start: 4.5, end: 6.0, text: 'a2' },
    ];
    const turns = [
      { start: 0.0, end: 2.2, speaker: 'SPEAKER_00' },
      { start: 2.3, end: 4.2, speaker: 'SPEAKER_01' },
      { start: 4.3, end: 6.2, speaker: 'SPEAKER_00' },
    ];
    const out = mergeSpeakers(segs, turns);
    expect(out.map((s) => s.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
  });

  it('does not mutate inputs', () => {
    const segs = [{ start: 0, end: 1, text: 'hi' }];
    const turns = [{ start: 0, end: 1, speaker: 'SPEAKER_00' }];
    mergeSpeakers(segs, turns);
    expect(segs[0]).toEqual({ start: 0, end: 1, text: 'hi' });
    expect(turns[0]).toEqual({ start: 0, end: 1, speaker: 'SPEAKER_00' });
  });
});

describe('summarizeSpeakers', () => {
  it('returns [] for empty input', () => {
    expect(summarizeSpeakers([])).toEqual([]);
  });

  it('aggregates segment count and totalSeconds per speaker', () => {
    const segs = [
      { start: 0, end: 2, speaker: 'SPEAKER_00' },
      { start: 2, end: 5, speaker: 'SPEAKER_01' },
      { start: 5, end: 6, speaker: 'SPEAKER_00' },
    ];
    const out = summarizeSpeakers(segs);
    expect(out).toEqual([
      { speaker: 'SPEAKER_00', segmentCount: 2, totalSeconds: 3 },
      { speaker: 'SPEAKER_01', segmentCount: 1, totalSeconds: 3 },
    ]);
  });

  it('sorts by descending totalSeconds', () => {
    const segs = [
      { start: 0, end: 1, speaker: 'A' },
      { start: 1, end: 6, speaker: 'B' },
    ];
    const out = summarizeSpeakers(segs);
    expect(out[0].speaker).toBe('B');
    expect(out[1].speaker).toBe('A');
  });

  it('skips segments with null speaker', () => {
    const segs = [
      { start: 0, end: 1, speaker: 'A' },
      { start: 1, end: 2, speaker: null },
    ];
    const out = summarizeSpeakers(segs);
    expect(out).toEqual([{ speaker: 'A', segmentCount: 1, totalSeconds: 1 }]);
  });
});
