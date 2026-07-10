import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const html = readFileSync(join(repoRoot, 'public/index.html'), 'utf8');
const workletMatch = html.match(/const LIVE_WORKLET_SOURCE = `([\s\S]*?)`;\n/);

describe('live transcription playground', () => {
  it('exposes a distinct Parakeet live workflow without putting credentials in the URL', () => {
    expect(html).toContain('id="startLiveBtn"');
    expect(html).toContain('id="stopLiveBtn"');
    expect(html).toContain("'/v1/realtime/transcription'");
    expect(html).toContain("liveSocket.send(event.data.samples.buffer)");
    expect(html).toContain('...(apiKey ? { apiKey } : {})');
    expect(html).not.toMatch(/WebSocket\([^\n]+apiKey/);
  });

  it('resamples a 48 kHz microphone block to an exact 16 kHz half-second frame', () => {
    expect(workletMatch).not.toBeNull();
    let Processor;
    class MockAudioWorkletProcessor {
      constructor() {
        this.port = {
          messages: [],
          postMessage: (message) => this.port.messages.push(message),
        };
      }
    }

    const context = {
      AudioWorkletProcessor: MockAudioWorkletProcessor,
      Float32Array,
      sampleRate: 48000,
      registerProcessor: (name, processor) => {
        expect(name).toBe('sogni-pcm-capture');
        Processor = processor;
      },
    };
    vm.runInNewContext(workletMatch[1], context);

    const processor = new Processor();
    const microphoneSamples = new Float32Array(24000).fill(0.25);
    expect(processor.process([[microphoneSamples]])).toBe(true);
    const pcmMessages = processor.port.messages.filter((message) => message.type === 'pcm');
    expect(pcmMessages).toHaveLength(1);
    expect(pcmMessages[0].samples).toHaveLength(8000);
    expect(Math.min(...pcmMessages[0].samples)).toBeCloseTo(0.25, 6);
    expect(Math.max(...pcmMessages[0].samples)).toBeCloseTo(0.25, 6);
  });
});
