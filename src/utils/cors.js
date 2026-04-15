const DEFAULT_LOCAL_CORS_ORIGINS = Object.freeze([
  'http://localhost',
  'http://localhost:*',
  'http://127.0.0.1',
  'http://127.0.0.1:*',
  'http://[::1]',
  'http://[::1]:*',
  'https://localhost',
  'https://localhost:*',
  'https://127.0.0.1',
  'https://127.0.0.1:*',
  'https://[::1]',
  'https://[::1]:*',
]);

const DISABLED_CORS_VALUES = new Set(['0', 'false', 'off', 'disabled', 'none']);
const LOCAL_CORS_VALUES = new Set(['local', 'localhost', 'loopback']);
const ANY_CORS_VALUES = new Set(['*', 'all', 'any']);

const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

const compileWildcardOrigin = (origin) =>
  new RegExp(`^${escapeRegex(origin).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`);

export const parseCorsOrigins = (value) => {
  if (value == null || value.trim() === '') {
    return [...DEFAULT_LOCAL_CORS_ORIGINS];
  }

  const normalized = value.trim().toLowerCase();

  if (DISABLED_CORS_VALUES.has(normalized)) {
    return [];
  }

  if (LOCAL_CORS_VALUES.has(normalized)) {
    return [...DEFAULT_LOCAL_CORS_ORIGINS];
  }

  if (ANY_CORS_VALUES.has(normalized)) {
    return ['*'];
  }

  const origins = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return origins.includes('*') ? ['*'] : origins;
};

export const buildCorsPolicy = (origins = []) => {
  const allowAnyOrigin = origins.includes('*');
  const exactOrigins = new Set();
  const wildcardOrigins = [];

  for (const origin of origins) {
    if (!origin || origin === '*') {
      continue;
    }

    if (origin.includes('*') || origin.includes('?')) {
      wildcardOrigins.push(compileWildcardOrigin(origin));
      continue;
    }

    exactOrigins.add(origin);
  }

  return {
    enabled: origins.length > 0,
    allowAnyOrigin,
    exactOrigins,
    wildcardOrigins,
  };
};

export const isCorsOriginAllowed = (origin, policy) => {
  if (!policy.enabled || !origin) {
    return false;
  }

  if (policy.allowAnyOrigin || policy.exactOrigins.has(origin)) {
    return true;
  }

  return policy.wildcardOrigins.some((pattern) => pattern.test(origin));
};

export const getCorsAllowOrigin = (origin, policy) => (policy.allowAnyOrigin ? '*' : origin);

export const normalizeCorsRequestHeaders = (value) => {
  if (!value) {
    return '';
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(', ');
};

export const localCorsOrigins = [...DEFAULT_LOCAL_CORS_ORIGINS];
