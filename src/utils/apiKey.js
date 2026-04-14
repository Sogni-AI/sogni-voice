import { timingSafeEqual } from 'node:crypto';

export const extractApiKeyFromHeaders = (headers = {}) => {
  const apiKeyHeader = headers['x-api-key'] || headers['X-API-Key'];
  const authHeader = headers.authorization || headers.Authorization;

  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
};

export const apiKeysMatch = (providedKey, expectedKey) => {
  if (!providedKey || !expectedKey) {
    return false;
  }

  const provided = Buffer.from(providedKey, 'utf8');
  const expected = Buffer.from(expectedKey, 'utf8');

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
};

export const requestHasValidApiKey = (request, expectedKey) => {
  const providedKey = extractApiKeyFromHeaders(request?.headers);
  return apiKeysMatch(providedKey, expectedKey);
};
