import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { dayKey, dayStart } from '../lib/days.js';
import { ApiError } from '../middleware/auth.js';
import { AdSession, Transaction, User } from '../models/index.js';
import { logSecurity } from './stats.js';

/* ------------------------------------------------------------------ *
 * Prize tables. The result is ALWAYS rolled on the server; the client
 * only plays an animation. Weights live in config.gameOdds (editable in the admin panel; defaults in config.js).
 *
 * ------------------------------------------------------------------ */
// Order = clockwise position on the wheel image, starting at the top (every 60 degrees)
export const WHEEL = [5, 10, 15, 25, 100, 0];

export const SCRATCH = [5, 10, 15, 20];

export const MYSTERY = [5, 10, 50];

function pickIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = crypto.randomInt(total);
  for (let i = 0; i < weights.length; i += 1) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

export const GAMES = {
  spin: {
    label: 'Lucky Spin',
    values: WHEEL,
    roll: () => pickIndex(config.gameOdds.spin),
    limit: () => config.spinDailyLimit,
    usedKey: 'spins',
    nextKey: 'spinNextAt',
    txType: 'game_spin',
  },
  scratch: {
    label: 'Scratch Card',
    values: SCRATCH,
    roll: () => pickIndex(config.gameOdds.scratch),
    limit: () => config.scratchDailyLimit,
    usedKey: 'scratches',
    nextKey: 'scratchNextAt',
    txType: 'game_scratch',
  },
};

export const rollMystery = () => MYSTERY[pickIndex(config.gameOdds.mystery)];

/* --------------------------------- state --------------------------------- */
const secondsUntil = (date) => (date ? Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000)) : 0);

export function cooldownSec(user, game) {
  const g = GAMES[game];
  return secondsUntil(user.games?.[g.nextKey]);
}

export function usedToday(user, game) {
  return user.daily?.[GAMES[game].usedKey] || 0;
}

export function gamesState(user) {
  const one = (game) => {
    const limit = GAMES[game].limit();
    const used = usedToday(user, game);
    return { limit, used, left: Math.max(0, limit - used), cooldownSec: cooldownSec(user, game) };
  };
  return {
    cooldownMinutes: config.gameCooldownMinutes,
    spin: { ...one('spin'), paidCost: config.spinPaidCost, prizes: WHEEL },
    scratch: { ...one('scratch'), min: Math.min(...SCRATCH), max: Math.max(...SCRATCH) },
    mystery: { cost: config.mysteryCost, prizes: MYSTERY },
  };
}

/* --------------------------- ad session handling --------------------------- */
/** Validates a finished ad session for a game and marks it as used (exactly once). */
export async function consumeGameSession(user, sessionId, game) {
  if (!mongoose.isValidObjectId(sessionId)) throw new ApiError(400, 'invalid_session', 'Watch an ad first');
  const s = await AdSession.findOne({ _id: sessionId, userId: user._id });
  if (!s || s.status !== 'pending' || s.kind !== 'game' || s.game !== game)
    throw new ApiError(400, 'invalid_session', 'This ad session is no longer valid');

  const elapsed = (Date.now() - s.createdAt.getTime()) / 1000;
  if (elapsed > 30 * 60) {
    await AdSession.updateOne({ _id: s._id }, { $set: { status: 'expired' } });
    throw new ApiError(400, 'expired', 'Ad session expired');
  }
  if (elapsed < s.minSeconds - 1) {
    if (elapsed < 5) logSecurity('fast_ad', user, { seconds: Math.round(elapsed), needed: s.minSeconds, kind: `game:${game}` });
    throw new ApiError(429, 'too_early', 'Please watch the whole ad first');
  }
  if (s.needsConfirm && !s.providerConfirmed) throw new ApiError(409, 'awaiting_provider', 'Waiting for ad confirmation');

  const gate = await AdSession.findOneAndUpdate(
    { _id: s._id, status: 'pending' },
    { $set: { status: 'completed', completedAt: new Date(), day: dayKey() } }
  );
  if (!gate) throw new ApiError(400, 'invalid_session');
  return s;
}

/** Throws when the user may not start/play `game` with an ad right now. */
export function assertCanPlayWithAd(user, game) {
  const g = GAMES[game];
  if (usedToday(user, game) >= g.limit()) throw new ApiError(409, 'limit_reached', 'No free plays left today');
  const wait = cooldownSec(user, game);
  if (wait > 0) {
    const mm = String(Math.floor(wait / 60)).padStart(2, '0');
    const ss = String(wait % 60).padStart(2, '0');
    throw new ApiError(429, 'cooldown', `Next ${g.label} in ${mm}:${ss}`);
  }
}

export const txn = (userId, type, amount, note) => Transaction.create({ userId, type, amount, note });

/** Atomic update for a free (ad) play: daily counter + cooldown + prize + ad view. */
export async function applyAdPlay(user, game, prize, today) {
  const g = GAMES[game];
  const now = new Date();
  const usedPath = `daily.${g.usedKey}`;
  const nextPath = `games.${g.nextKey}`;
  return User.findOneAndUpdate(
    {
      _id: user._id,
      'daily.date': today,
      $and: [
        { $or: [{ [usedPath]: { $exists: false } }, { [usedPath]: { $lt: g.limit() } }] },
        { $or: [{ [nextPath]: null }, { [nextPath]: { $lte: now } }] },
      ],
    },
    {
      $inc: { balance: prize, totalEarned: prize, adsWatched: 1, 'daily.adsCount': 1, [usedPath]: 1 },
      $set: { [nextPath]: new Date(now.getTime() + config.gameCooldownMinutes * 60_000), lastAdAt: now },
    },
    { new: true }
  );
}

/** Atomic "pay points, get prize" for paid plays. Returns the updated user or null if balance is too low. */
export function applyPaidPlay(user, cost, prize) {
  return User.findOneAndUpdate(
    { _id: user._id, balance: { $gte: cost } },
    { $inc: { balance: prize - cost, totalEarned: prize } },
    { new: true }
  );
}

/* ------------------------------- leaderboard ------------------------------- */
let cache = { day: null, at: 0, rows: [] };
const CACHE_MS = 45_000;
const EXCLUDED = ['withdraw', 'withdraw_refund', 'admin'];

async function todayRows(today) {
  if (cache.day === today && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await Transaction.aggregate([
    { $match: { createdAt: { $gte: dayStart() }, type: { $nin: EXCLUDED } } },
    { $group: { _id: '$userId', pts: { $sum: '$amount' } } },
    { $match: { pts: { $gt: 0 } } },
    { $sort: { pts: -1 } },
    { $limit: 200 },
  ]);
  cache = { day: today, at: Date.now(), rows };
  return rows;
}

const displayName = (u) => {
  const n = (u?.firstName || '').trim() || (u?.username ? '@' + u.username : '');
  return n ? n.slice(0, 14) : 'Player';
};

/** Net points earned today (game costs are subtracted). */
export async function leaderboard(user, today) {
  const rows = await todayRows(today);
  const top = rows.slice(0, 10);
  const users = await User.find({ _id: { $in: top.map((r) => r._id) } })
    .select('firstName username')
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const myIdx = rows.findIndex((r) => String(r._id) === String(user._id));
  let myPoints = myIdx >= 0 ? rows[myIdx].pts : 0;
  if (myIdx < 0) {
    const mine = await Transaction.aggregate([
      { $match: { userId: user._id, createdAt: { $gte: dayStart() }, type: { $nin: EXCLUDED } } },
      { $group: { _id: null, pts: { $sum: '$amount' } } },
    ]);
    myPoints = Math.max(0, mine[0]?.pts || 0);
  }

  return {
    top: top.map((r, i) => ({
      rank: i + 1,
      name: displayName(byId.get(String(r._id))),
      points: r.pts,
      me: String(r._id) === String(user._id),
    })),
    me: { rank: myIdx >= 0 ? myIdx + 1 : null, points: myPoints },
  };
}
