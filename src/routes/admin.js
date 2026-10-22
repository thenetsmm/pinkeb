import { Router } from 'express';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { adminGuard } from '../middleware/adminAuth.js';
import { ApiError } from '../middleware/auth.js';
import {
  User, Offer, OfferClaim, Withdrawal, PromoCode, PromoRedemption, Transaction, DailyStat, SecurityLog,
} from '../models/index.js';
import { dayKey, dayStart } from '../lib/days.js';
import { resolveWithdrawal } from '../services/withdrawals.js';
import { editableValues, saveSettings } from '../services/settings.js';
import { sendMessage, escapeHtml } from '../lib/telegram.js';
import { job, recipientCount, startBroadcast } from '../services/broadcast.js';
import { logSecurity } from '../services/stats.js';

const router = Router();
router.use(adminGuard);

const DAY = 86_400_000;
const oid = (v) => {
  if (!mongoose.isValidObjectId(v)) throw new ApiError(400, 'bad_request', 'Invalid id');
  return v;
};
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.post('/verify', (req, res) => res.json({ ok: true, adminId: req.adminId }));

/* ------------------------------ 1. overview ------------------------------ */
function bounds(range) {
  const start = dayStart();
  const now = new Date();
  if (range === 'yesterday') return { from: new Date(start - DAY), to: start, days: 1, keys: [dayKey(new Date(start - DAY / 2))] };
  if (range === '7d') {
    const keys = Array.from({ length: 7 }, (_, i) => dayKey(new Date(now - i * DAY)));
    return { from: new Date(start - 6 * DAY), to: now, days: 7, keys };
  }
  if (range === 'all') return { from: new Date(0), to: now, days: 0, keys: null };
  return { from: start, to: now, days: 1, keys: [dayKey()] };
}

router.get('/overview', async (req, res) => {
  const range = ['today', 'yesterday', '7d', 'all'].includes(req.query.range) ? req.query.range : 'today';
  const b = bounds(range);
  const [stats, points, joined, totalUsers, liab] = await Promise.all([
    DailyStat.find(b.keys ? { day: { $in: b.keys } } : {}).lean(),
    Transaction.aggregate([
      { $match: { createdAt: { $gte: b.from, $lt: b.to }, type: { $nin: ['withdraw', 'withdraw_refund', 'admin'] } } },
      { $group: { _id: null, pts: { $sum: '$amount' } } },
    ]),
    User.countDocuments({ createdAt: { $gte: b.from, $lt: b.to } }),
    User.estimatedDocumentCount(),
    User.aggregate([
      { $match: { banned: false } },
      { $group: { _id: null, pts: { $sum: { $add: ['$balance', '$bonusBalance'] } }, n: { $sum: 1 } } },
    ]),
  ]);

  const ads = { main: 0, task: 0, spin: 0, scratch: 0, piggy: 0, promo: 0, offer: 0 };
  let adsTotal = 0;
  let dauSum = 0;
  for (const s of stats) {
    adsTotal += s.adsTotal || 0;
    dauSum += s.dau || 0;
    for (const [k, v] of Object.entries(s.ads || {})) ads[k] = (ads[k] || 0) + v;
  }
  const dayCount = b.days || Math.max(1, stats.length);
  const dau = b.days === 1 ? dauSum : Math.round(dauSum / dayCount);
  const pointsDistributed = Math.max(0, points[0]?.pts || 0);
  const revenue = adsTotal * config.adRevenueKs;
  res.json({
    range,
    users: { total: totalUsers, joined, dau },
    ads: { total: adsTotal, breakdown: ads },
    revenueKs: revenue,
    adRevenueKs: config.adRevenueKs,
    pointsDistributed,
    netProfitKs: revenue - pointsDistributed * (1 / config.ptsPerKs),
    liabilityPts: liab[0]?.pts || 0,
    ptsPerKs: config.ptsPerKs,
  });
});

/* ------------------------------ 2. withdrawals ------------------------------ */
router.get('/withdrawals', async (req, res) => {
  const status = ['pending', 'success', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const filter = { status };
  if (config.withdrawMethods.includes(req.query.method)) filter.method = req.query.method;
  const [list, pendingCount] = await Promise.all([
    Withdrawal.find(filter).sort({ createdAt: -1 }).limit(50).lean(),
    Withdrawal.countDocuments({ status: 'pending' }),
  ]);

  const items = await Promise.all(
    list.map(async (w) => {
      const [u, active, pending, game] = await Promise.all([
        User.findById(w.userId).select('firstName lastName username telegramId adsWatched balance banned').lean(),
        User.countDocuments({ invitedBy: w.telegramId, referralActivated: true }),
        User.countDocuments({ invitedBy: w.telegramId, referralActivated: false }),
        Transaction.aggregate([
          { $match: { userId: w.userId, type: { $in: ['game_spin', 'game_scratch', 'game_mystery'] }, amount: { $gt: 0 } } },
          { $group: { _id: null, pts: { $sum: '$amount' } } },
        ]),
      ]);
      const ads = u?.adsWatched || 0;
      const risk = ads < 5;
      return {
        id: String(w._id),
        ref: 'WD-' + String(w._id).slice(-5).toUpperCase(),
        name: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || 'User',
        username: u?.username || '',
        telegramId: w.telegramId,
        amountKs: w.amountKs,
        points: w.points,
        method: w.method,
        account: w.account,
        accountName: w.accountName,
        status: w.status,
        reason: w.reason || '',
        createdAt: w.createdAt,
        banned: !!u?.banned,
        fraud: {
          ads,
          active,
          pending,
          gamePoints: game[0]?.pts || 0,
          risk,
          note: risk ? `High risk: ${w.points} pts payout requested with only ${ads} ads watched. Review before action.` : '',
        },
      };
    })
  );
  res.json({ items, pendingCount });
});

const reasonOf = (req) => String(req.body?.reason || '').trim().slice(0, 200);

router.post('/withdrawals/:id/approve', async (req, res) => {
  const w = await resolveWithdrawal(oid(req.params.id), 'approve');
  if (!w) throw new ApiError(409, 'already_resolved', 'Withdrawal not found or already handled');
  res.json({ ok: true, status: w.status });
});
router.post('/withdrawals/:id/reject', async (req, res) => {
  const reason = reasonOf(req);
  if (!reason) throw new ApiError(400, 'reason_required', 'Choose a reason');
  const w = await resolveWithdrawal(oid(req.params.id), 'reject', reason);
  if (!w) throw new ApiError(409, 'already_resolved', 'Withdrawal not found or already handled');
  res.json({ ok: true, status: w.status, refunded: w.points });
});
router.post('/withdrawals/:id/reject-ban', async (req, res) => {
  const w = await resolveWithdrawal(oid(req.params.id), 'reject', reasonOf(req) || 'Fraud detected', { refund: false });
  if (!w) throw new ApiError(409, 'already_resolved', 'Withdrawal not found or already handled');
  await User.updateOne({ _id: w.userId }, { $set: { banned: true, banReason: 'Fraud (withdrawal rejected)' } });
  logSecurity('admin', { _id: w.userId, telegramId: w.telegramId }, { action: 'reject_ban', amountKs: w.amountKs });
  res.json({ ok: true, status: w.status, banned: true });
});

/* ------------------------------ 3. users ------------------------------ */
const userRow = (u) => ({
  telegramId: u.telegramId,
  name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'User',
  username: u.username || '',
  balance: u.balance,
  totalEarned: u.totalEarned,
  adsWatched: u.adsWatched,
  banned: !!u.banned,
  joinedAt: u.createdAt,
});
const USER_FIELDS = 'telegramId firstName lastName username balance totalEarned adsWatched banned createdAt';

router.get('/users', async (req, res) => {
  const q = String(req.query.search || '').trim().replace(/^@/, '');
  const sort = req.query.sort;
  const filter = {};
  if (q) filter.$or = /^\d+$/.test(q) ? [{ telegramId: Number(q) }] : [{ username: new RegExp('^' + esc(q), 'i') }, { firstName: new RegExp('^' + esc(q), 'i') }];
  if (sort === 'banned') filter.banned = true;

  let users;
  if (sort === 'inviters' && !q) {
    const top = await User.aggregate([
      { $match: { invitedBy: { $ne: null } } },
      { $group: { _id: '$invitedBy', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 30 },
    ]);
    const found = await User.find({ telegramId: { $in: top.map((t) => t._id) } }).select(USER_FIELDS).lean();
    const byId = new Map(found.map((u) => [u.telegramId, u]));
    users = top.filter((t) => byId.has(t._id)).map((t) => ({ ...userRow(byId.get(t._id)), invited: t.n }));
  } else {
    const order = sort === 'balance' ? { balance: -1 } : { createdAt: -1 };
    users = (await User.find(filter).sort(order).limit(30).select(USER_FIELDS).lean()).map(userRow);
  }
  res.json({ users });
});

async function userDetail(telegramId) {
  const u = await User.findOne({ telegramId }).lean();
  if (!u) throw new ApiError(404, 'not_found', 'User not found');
  const friends = await User.find({ invitedBy: telegramId })
    .sort({ createdAt: -1 })
    .limit(100)
    .select('telegramId firstName username referralActivated adsWatched lastIp')
    .lean();
  const sameIp = u.lastIp ? await User.countDocuments({ lastIp: u.lastIp, telegramId: { $ne: telegramId } }) : 0;
  return {
    ...userRow(u),
    bonusBalance: u.bonusBalance,
    invitedBy: u.invitedBy,
    sameIpAccounts: sameIp,
    usage: {
      spins: u.daily?.spins || 0,
      scratches: u.daily?.scratches || 0,
      mainAds: u.daily?.mainAds || 0,
      taskAds: u.daily?.taskAds || 0,
      spinLimit: config.spinDailyLimit,
      scratchLimit: config.scratchDailyLimit,
      mainLimit: config.mainAdDailyLimit,
      taskTarget: config.adsTaskTarget,
    },
    friends: friends.map((f) => ({
      telegramId: f.telegramId,
      name: f.username ? '@' + f.username : f.firstName || 'Friend',
      active: !!f.referralActivated,
      ads: f.adsWatched,
      sameIp: !!(u.lastIp && f.lastIp === u.lastIp),
    })),
  };
}

router.get('/users/:tg', async (req, res) => res.json(await userDetail(Number(req.params.tg))));

router.post('/users/:tg/balance', async (req, res) => {
  const tg = Number(req.params.tg);
  const delta = Math.trunc(Number(req.body?.delta));
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) throw new ApiError(400, 'bad_request', 'Enter an amount');
  const filter = delta < 0 ? { telegramId: tg, balance: { $gte: -delta } } : { telegramId: tg };
  const u = await User.findOneAndUpdate(filter, { $inc: { balance: delta } }, { new: true });
  if (!u) throw new ApiError(400, 'insufficient', 'User not found or balance too low to deduct');
  await Transaction.create({ userId: u._id, type: 'admin', amount: delta, note: 'Admin adjustment' });
  logSecurity('admin', u, { action: 'balance', delta, by: req.adminId });
  res.json({ ok: true, balance: u.balance });
});

router.post('/users/:tg/reset', async (req, res) => {
  const what = req.body?.what;
  const sets = {
    games: { 'daily.spins': 0, 'daily.scratches': 0, 'games.spinNextAt': null, 'games.scratchNextAt': null },
    main: { 'daily.mainAds': 0, mainAdNextAt: null },
    task: { 'daily.taskAds': 0, 'daily.ads5': false },
    piggy: { 'piggy.startedAt': new Date() },
  }[what];
  if (!sets) throw new ApiError(400, 'bad_request', 'Unknown reset');
  const u = await User.findOneAndUpdate({ telegramId: Number(req.params.tg) }, { $set: sets }, { new: true });
  if (!u) throw new ApiError(404, 'not_found');
  res.json({ ok: true });
});

router.post('/users/:tg/ban', async (req, res) => {
  const banned = req.body?.banned !== false;
  const u = await User.findOneAndUpdate(
    { telegramId: Number(req.params.tg) },
    { $set: { banned, banReason: banned ? String(req.body?.reason || 'Banned by admin').slice(0, 200) : '' } },
    { new: true }
  );
  if (!u) throw new ApiError(404, 'not_found');
  logSecurity('admin', u, { action: banned ? 'ban' : 'unban', by: req.adminId });
  res.json({ ok: true, banned: u.banned });
});

router.post('/users/:tg/message', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 3000) throw new ApiError(400, 'bad_request', 'Write a message (max 3000 characters)');
  const r = await sendMessage(Number(req.params.tg), text);
  if (!r?.ok) throw new ApiError(502, 'send_failed', 'Telegram could not deliver the message (the user may have blocked the bot)');
  res.json({ ok: true });
});

/* ------------------------------ 4. settings ------------------------------ */
router.get('/settings', (req, res) => res.json({ values: editableValues(), prizes: { spin: [5, 10, 15, 25, 100, 0], scratch: [5, 10, 15, 20], mystery: [5, 10, 50] } }));
router.put('/settings', async (req, res) => {
  res.json({ ok: true, values: await saveSettings(req.body?.values || req.body) });
});

/* ------------------------------ 5. tasks & offers ------------------------------ */
const taskOut = (o) => ({
  id: String(o._id), title: o.title, type: o.type || 'ad', reward: o.reward, url: o.url, channel: o.channel,
  icon: o.icon, seconds: o.seconds, dailyLimit: o.dailyLimit, active: o.active,
});
router.get('/tasks', async (req, res) => res.json({ tasks: (await Offer.find().sort({ sort: 1, createdAt: 1 }).lean()).map(taskOut) }));
router.post('/tasks', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 60);
  const type = ['ad', 'link', 'channel'].includes(b.type) ? b.type : 'ad';
  const reward = Math.trunc(Number(b.reward));
  if (!title || !(reward > 0 && reward <= 10000)) throw new ApiError(400, 'bad_request', 'Title and reward are required');
  let url = String(b.url || '').trim();
  let channel = String(b.channel || '').trim().replace(/^@/, '');
  if (url && !/^https?:\/\//i.test(url)) throw new ApiError(400, 'bad_request', 'Link must start with https://');
  if (type === 'channel') {
    if (!channel) channel = (url.match(/t\.me\/([A-Za-z0-9_]{4,})/) || [])[1] || '';
    if (!channel) throw new ApiError(400, 'bad_request', 'Enter the @channel username');
    url = url || `https://t.me/${channel}`;
  }
  if (type === 'link' && !url) throw new ApiError(400, 'bad_request', 'Enter the website link');
  const count = await Offer.countDocuments();
  const o = await Offer.create({
    key: 'task-' + crypto.randomBytes(4).toString('hex'),
    title, type, reward, url, channel,
    icon: String(b.icon || (type === 'channel' ? 'telegram-plane' : type === 'link' ? 'share' : 'play')).slice(0, 30),
    seconds: Math.max(5, Math.trunc(Number(b.seconds)) || 15),
    dailyLimit: Math.max(1, Math.trunc(Number(b.dailyLimit)) || 3),
    sort: count + 1,
  });
  res.json(taskOut(o));
});
router.patch('/tasks/:id', async (req, res) => {
  const o = await Offer.findByIdAndUpdate(oid(req.params.id), { $set: { active: req.body?.active !== false } }, { new: true });
  if (!o) throw new ApiError(404, 'not_found');
  res.json(taskOut(o));
});
router.delete('/tasks/:id', async (req, res) => {
  await Offer.deleteOne({ _id: oid(req.params.id) });
  await OfferClaim.deleteMany({ offerId: req.params.id });
  res.json({ ok: true });
});

/* ------------------------------ 6. promo codes & broadcast ------------------------------ */
const promoOut = (p) => ({
  id: String(p._id), code: p.code, reward: p.reward, maxUses: p.maxUses, uses: p.uses,
  expiresAt: p.expiresAt, requireAd: p.requireAd !== false, active: p.active,
});
router.get('/promos', async (req, res) => res.json({ promos: (await PromoCode.find().sort({ createdAt: -1 }).limit(100).lean()).map(promoOut) }));
router.post('/promos', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
  const reward = Math.trunc(Number(b.reward));
  if (!code || !(reward > 0 && reward <= 100000)) throw new ApiError(400, 'bad_request', 'Code and reward are required');
  const hours = Number(b.hours);
  const p = await PromoCode.findOneAndUpdate(
    { code },
    {
      $set: {
        reward,
        maxUses: Math.max(0, Math.trunc(Number(b.maxUses)) || 0),
        expiresAt: hours > 0 ? new Date(Date.now() + hours * 3600_000) : null,
        requireAd: b.requireAd !== false,
        active: true,
        uses: 0,
      },
    },
    { upsert: true, new: true }
  );
  await PromoRedemption.deleteMany({ promoId: p._id }); // re-creating a code starts it fresh
  res.json(promoOut(p));
});
router.delete('/promos/:id', async (req, res) => {
  await PromoCode.deleteOne({ _id: oid(req.params.id) });
  await PromoRedemption.deleteMany({ promoId: req.params.id });
  res.json({ ok: true });
});

router.get('/broadcast', async (req, res) => res.json({ recipients: await recipientCount(), job }));
router.post('/broadcast', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  const imageUrl = String(req.body?.imageUrl || '').trim();
  const appUrl = String(req.body?.appUrl || '').trim();
  if (!text || text.length > 3500) throw new ApiError(400, 'bad_request', 'Write the message (max 3500 characters)');
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new ApiError(400, 'bad_request', 'Image URL must start with https://');
  if (appUrl && !/^https:\/\//i.test(appUrl)) throw new ApiError(400, 'bad_request', 'App URL must start with https://');
  if (req.body?.confirm !== true) throw new ApiError(400, 'confirm_required', 'Please confirm the broadcast');
  try {
    await startBroadcast({ text, imageUrl, appUrl, buttonText: String(req.body?.buttonText || '').trim().slice(0, 40) });
  } catch (e) {
    throw new ApiError(409, 'busy', e.message);
  }
  logSecurity('admin', null, { action: 'broadcast', by: req.adminId, recipients: job.total });
  res.json({ ok: true, job });
});

/* ------------------------------ 7. security ------------------------------ */
const maskIp = (ip) => {
  const p = String(ip).split('.');
  return p.length === 4 ? `${p[0]}.***.***.${p[3]}` : String(ip).slice(0, 6) + '…';
};
router.get('/security', async (req, res) => {
  const since = new Date(Date.now() - DAY);
  const [groups, fast, logs] = await Promise.all([
    User.aggregate([
      { $match: { lastIp: { $ne: '' } } },
      {
        $group: {
          _id: '$lastIp',
          n: { $sum: 1 },
          users: { $push: { telegramId: '$telegramId', username: '$username', firstName: '$firstName', banned: '$banned', invitedBy: '$invitedBy', active: '$referralActivated' } },
        },
      },
      { $match: { n: { $gte: 3 } } },
      { $sort: { n: -1 } },
      { $limit: 15 },
    ]),
    SecurityLog.aggregate([
      { $match: { type: 'fast_ad', createdAt: { $gte: since } } },
      { $group: { _id: '$telegramId', n: { $sum: 1 }, min: { $min: '$detail.seconds' }, last: { $max: '$createdAt' } } },
      { $sort: { n: -1 } },
      { $limit: 20 },
    ]),
    SecurityLog.find().sort({ createdAt: -1 }).limit(30).lean(),
  ]);

  const names = await User.find({ telegramId: { $in: fast.map((f) => f._id) } }).select('telegramId username firstName').lean();
  const nameOf = new Map(names.map((u) => [u.telegramId, u.username ? '@' + u.username : u.firstName || String(u.telegramId)]));
  const text = (l) =>
    l.type === 'fast_ad' ? `Fast claim · ${l.detail?.seconds ?? '?'}s (needs ${l.detail?.needed ?? '?'}s)` :
    l.type === 'withdraw_risk' ? `Withdrawal review raised · ${l.detail?.points ?? ''} pts, ${l.detail?.ads ?? 0} ads` :
    `Admin · ${l.detail?.action || 'action'}`;

  res.json({
    sameIp: groups.map((g) => {
      const ids = new Set(g.users.map((u) => u.telegramId));
      return {
        ip: maskIp(g._id),
        count: g.n,
        refersEachOther: g.users.some((u) => u.invitedBy && ids.has(u.invitedBy)),
        users: g.users.map((u) => ({
          telegramId: u.telegramId,
          name: u.username ? '@' + u.username : u.firstName || 'User',
          banned: !!u.banned,
          flagged: !!(u.invitedBy && ids.has(u.invitedBy)),
        })),
      };
    }),
    fastAds: fast.map((f) => ({ telegramId: f._id, name: nameOf.get(f._id) || String(f._id), count: f.n, seconds: f.min, last: f.last })),
    logs: logs.map((l) => ({ id: String(l._id), text: text(l), who: l.telegramId || null, at: l.createdAt })),
    switches: { maintenance: !!config.maintenance, pauseWithdrawals: !!config.pauseWithdrawals },
  });
});
router.post('/security/ban', async (req, res) => {
  const ids = (Array.isArray(req.body?.telegramIds) ? req.body.telegramIds : []).map(Number).filter(Boolean).slice(0, 50);
  if (!ids.length) throw new ApiError(400, 'bad_request', 'No accounts selected');
  const r = await User.updateMany({ telegramId: { $in: ids } }, { $set: { banned: true, banReason: 'Multi-account / same IP' } });
  logSecurity('admin', null, { action: 'quick_ban', count: ids.length, by: req.adminId });
  res.json({ ok: true, banned: r.modifiedCount });
});

export default router;
