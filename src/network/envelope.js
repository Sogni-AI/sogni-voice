export function encodeFrame(type, data = {}) {
  return JSON.stringify({
    type,
    data: Buffer.from(JSON.stringify(data), 'utf-8').toString('base64'),
  });
}

export function decodeFrame(raw) {
  const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));

  if (!message || typeof message.type !== 'string') {
    throw new Error('Frame is missing a string "type"');
  }

  const data = message.data
    ? JSON.parse(Buffer.from(message.data, 'base64').toString('utf-8'))
    : null;

  return { type: message.type, data };
}
