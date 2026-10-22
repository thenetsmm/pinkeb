import { config } from '../config.js';
import { validateInitData } from '../lib/telegramAuth.js';
import { dayKey } from '../lib/days.js';
import { ensureUser } from '../services/users.js';
import { User } from '../models/index.js';
import { bumpDau } from '../services/stats.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/** Authenticates the request using Telegram initData: `Authorization: tma <initData>` */
export async function auth(req, res, next) {
  let tgUser = null;
  let startParam = null;

  const header = req.get('authorization') || '';
  if (header.startsWith('tma ')) {
    const parsed = validateInitData(header.slice(4), config.botToken);
    if (parsed) {
      tgUser = parsed.user;
      startParam = parsed.startParam;
    }
  } else if (config.devAuth && req.get('x-dev-user')) {
    tgUser = { id: Number(req.get('x-dev-user')), first_name: 'Dev', username: 'dev' };
    startParam = req.get('x-dev-start') || null;
  }

  if (!tgUser || !tgUser.id) throw new ApiError(401, 'unauthorized', 'Please open this app from Telegram');

  let user = await ensureUser(tgUser, startParam);
  if (user.banned) throw new ApiError(403, 'banned', 'Your account is blocked');
  const isAdmin = config.adminIds.includes(user.telegramId);
  if (config.maintenance && !isAdmin)
    throw new ApiError(503, 'maintenance', '🛠️ App is being upgraded. Please wait a little while.');

  // remember the network address (used by the same-IP / multi-account detector)
  const ip = String(req.ip || '').replace('::ffff:', '');
  if (ip && user.lastIp !== ip) {
    User.updateOne({ _id: user._id }, { $set: { lastIp: ip } }).catch(() => {});
    user.lastIp = ip;
  }

  // Roll the "daily" counters over when a new day (in the configured timezone) starts. Atomic + idempotent.
  const today = dayKey();
  if (user.daily?.date !== today) {
    const rolled = await User.findOneAndUpdate(
      { _id: user._id, 'daily.date': { $ne: today } },
      { $set: { daily: { date: today, adsCount: 0, checkin: false, ads5: false, spins: 0, scratches: 0, taskAds: 0, mainAds: 0 } } },
      { new: true }
    );
    if (rolled) bumpDau(); // first visit of the day = one daily active user
    user = rolled || (await User.findById(user._id));
  }

  req.user = user;
  req.isAdmin = isAdmin;
  req.today = today;
  next();
}

/** Protects /api/admin/* with the ADMIN_API_KEY env var. */
export function adminOnly(req, res, next) {
  const key = req.get('x-admin-key') || '';
  if (!config.adminApiKey || key.length !== config.adminApiKey.length || key !== config.adminApiKey) {
    throw new ApiError(401, 'unauthorized', 'Invalid admin key');
  }
  next();
}
