const crypto = require('node:crypto');

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 24) {
    const error = new Error('Set JWT_SECRET to a random secret of at least 24 characters.');
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }
  return value;
}

function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 7) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds })).toString('base64url');
  const input = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret()).update(input).digest('base64url');
  return `${input}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const input = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret()).update(input).digest();
  let supplied;
  try { supplied = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function hashCode(value) {
  return crypto.createHmac('sha256', process.env.OTP_SECRET || secret()).update(String(value)).digest('hex');
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(String(password), salt, 64, (error, key) => {
      if (error) return reject(error);
      resolve(`${salt}:${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [salt, key] = String(stored || '').split(':');
    if (!salt || !key) return resolve(false);
    crypto.scrypt(String(password), salt, 64, (error, derived) => {
      if (error) return resolve(false);
      const expected = Buffer.from(key, 'hex');
      resolve(expected.length === derived.length && crypto.timingSafeEqual(expected, derived));
    });
  });
}

module.exports = { signToken, verifyToken, hashCode, hashPassword, verifyPassword };
