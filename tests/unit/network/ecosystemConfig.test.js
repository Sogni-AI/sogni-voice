import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ecosystemPath = require.resolve('../../../ecosystem.config.cjs');
const originalValue = process.env.SOGNI_NETWORK_WORKER;

function loadEcosystemConfig(value) {
  process.env.SOGNI_NETWORK_WORKER = value;
  delete require.cache[ecosystemPath];
  return require(ecosystemPath);
}

afterEach(() => {
  if (originalValue === undefined) delete process.env.SOGNI_NETWORK_WORKER;
  else process.env.SOGNI_NETWORK_WORKER = originalValue;
  delete require.cache[ecosystemPath];
});

describe('PM2 ecosystem config', () => {
  it.each(['', '0', 'false', 'off'])(
    'keeps standalone API installs isolated when SOGNI_NETWORK_WORKER=%j',
    (value) => {
      const ecosystem = loadEcosystemConfig(value);

      expect(ecosystem.apps.map((app) => app.name)).toEqual(['sogni-voice']);
    },
  );

  it.each(['1', 'true', 'yes', 'on'])(
    'includes the network worker only after explicit opt-in with %j',
    (value) => {
      const ecosystem = loadEcosystemConfig(value);

      expect(ecosystem.apps.map((app) => app.name))
        .toEqual(['sogni-voice', 'sogni-speech-worker']);
      expect(ecosystem.apps[1].env.SOGNI_NETWORK_WORKER).toBe('true');
      expect(ecosystem.apps[1].env_production.SOGNI_NETWORK_WORKER).toBe('true');
    },
  );
});
