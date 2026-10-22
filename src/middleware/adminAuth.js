import crypto from 'node:crypto';
import { config } from '../config.js';
import { validateInitData } from '../lib/telegramAuth.js';
import { ApiError } from './auth.js';

const fails = new Map(); // telegramId -> { n, until }
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Protects /api/admin/*. Two ways in:
 *  1) Telegram identity (initData) is in ADMIN_IDS  AND  the secret PIN header (x-admin-pin) equals ADMIN_PIN
 *  2) legacy: x-admin-key equals ADMIN_API_KEY (for curl / scripts)
 */
export function adminGuard(req, res, next) {
  const key = req.get('x-admin-key');
  if (key && config.adminApiKey && same(key, config.adminApiKey)) {
    req.adminId = 0;
    return next();
  }

  let tgUser = null;
  const header = req.get('authorization') || '';
  if (header.startsWith('tma ')) tgUser = validateInitData(header.slice(4), config.botToken)?.user || null;
  else if (config.devAuth && req.get('x-dev-user')) tgUser = { id: Number(req.get('x-dev-user')) };
  if (!tgUser?.id) throw new ApiError(401, 'unauthorized', 'Open this panel from Telegram');
  if (!config.adminIds.includes(tgUser.id)) throw new ApiError(403, 'forbidden', 'Not allowed');
  if (!/^\d{6}$/.test(config.adminPin)) throw new ApiError(503, 'no_pin', 'Set ADMIN_PIN (6 digits) in the server environment');

  const f = fails.get(tgUser.id);
  if (f && f.until > Date.now()) throw new ApiError(429, 'locked', 'Too many wrong PINs. Try again in a few minutes.');

  if (!same(req.get('x-admin-pin') || '', config.adminPin)) {
    const n = (f?.n || 0) + 1;
    fails.set(tgUser.id, { n, until: n >= 5 ? Date.now() + 10 * 60_000 : 0 });
    throw new ApiError(401, 'bad_pin', 'Wrong PIN');
  }
  fails.delete(tgUser.id);
  req.adminId = tgUser.id;
  next();
}
