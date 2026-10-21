import { Router } from 'express';
import { config } from '../config.js';
import { ApiError } from '../middleware/auth.js';
import { AdSession, PromoCode, PromoRedemption, User, Transaction } from '../models/index.js';
import { applyReferralRewards } from '../services/referrals.js';
import { consumeGameSession } from '../services/games.js';
import { claimPiggy, isPiggyReady } from '../services/piggy.js';
import { tg } from '../lib/telegram.js';

// Mounted at /api, AFTER auth. Piggy bank, promo codes, channel bonus.
const router = Router();
const credit = (userId, type, amount, note) => Transaction.create({ userId, type, amount, note });

async function openAdSession(user, game, meta = '') {
  await AdSession.updateMany({ userId: user._id, status: 'pending' }, { $set: { status: 'expired' } });
  const s = await AdSession.create({
    userId: user._id,
    kind: 'game',
    game,
    meta,
    reward: 0,
    minSeconds: config.gameAdSeconds,
    needsConfirm: config.requireProviderConfirm && !!config.adsgramRewardSecret,
  });
  return { sessionId: String(s._id), seconds: config.gameAdSeconds };
}

/* ------------------------------- piggy bank ------------------------------- */
router.post('/piggy/claim', async (req, res) => {
  const updated = await claimPiggy(req.user, config.piggyBase);
  await credit(req.user._id, 'piggy', config.piggyBase, 'Piggy Bank');
  res.json({ ok: true, reward: config.piggyBase, balance: updated.balance });
});

router.post('/piggy/start', async (req, res) => {
  if (!(await isPiggyReady(req.user))) throw new ApiError(409, 'not_ready', 'The piggy bank is not full yet');
  res.json(await openAdSession(req.user, 'piggy'));
});

router.post('/piggy/claim-double', async (req, res) => {
  await consumeGameSession(req.user, req.body?.sessionId, 'piggy');
  const updated = await claimPiggy(req.user, config.piggyBoosted);
  await credit(req.user._id, 'piggy', config.piggyBoosted, 'Piggy Bank (2x with ad)');
  // the ad view counts like any other ad view
  const after = await User.findByIdAndUpdate(updated._id, { $inc: { adsWatched: 1, 'daily.adsCount': 1 } }, { new: true });
  await applyReferralRewards(after, config.mainAdReward);
  res.json({ ok: true, reward: config.piggyBoosted, balance: updated.balance });
});

/* -------------------------------- promo codes -------------------------------- */
const attempts = new Map(); // telegramId -> { n, resetAt }  (simple brute-force guard)
function guard(user) {
  const now = Date.now();
  const a = attempts.get(user.telegramId);
  if (!a || a.resetAt < now) attempts.set(user.telegramId, { n: 0, resetAt: now + 60_000 });
  if (attempts.get(user.telegramId).n >= 8) throw new ApiError(429, 'too_many', 'Too many tries. Wait a minute and try again.');
}
const fail = (user, status, code, msg) => {
  attempts.get(user.telegramId).n += 1;
  throw new ApiError(status, code, msg);
};

const normalize = (c) => String(c || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);

async function checkPromo(user, code) {
  if (!code) fail(user, 400, 'invalid_code', 'Enter a promo code');
  const promo = await PromoCode.findOne({ code });
  if (!promo || !promo.active) fail(user, 404, 'invalid_code', 'This code is not valid');
  if (promo.expiresAt && promo.expiresAt.getTime() <= Date.now()) fail(user, 410, 'expired', 'This code has expired');
  if (promo.maxUses > 0 && promo.uses >= promo.maxUses) fail(user, 410, 'fully_used', 'This code has been fully used');
  if (await PromoRedemption.exists({ userId: user._id, promoId: promo._id }))
    fail(user, 409, 'already_used', 'You already used this code');
  return promo;
}

// 1) validate the code, then the app shows an ad
router.post('/promo/check', async (req, res) => {
  guard(req.user);
  const code = normalize(req.body?.code);
  const promo = await checkPromo(req.user, code);
  res.json({ ok: true, reward: promo.reward, ...(await openAdSession(req.user, 'promo', promo.code)) });
});

// 2) after the ad: pay once
router.post('/promo/redeem', async (req, res) => {
  guard(req.user);
  const code = normalize(req.body?.code);
  const promo = await checkPromo(req.user, code);
  const session = await consumeGameSession(req.user, req.body?.sessionId, 'promo');
  if (session.meta !== promo.code) throw new ApiError(400, 'invalid_session', 'This ad was for a different code');

  // unique index = one redemption per user, even with parallel requests
  try {
    await PromoRedemption.create({ userId: req.user._id, promoId: promo._id });
  } catch (e) {
    if (e.code === 11000) throw new ApiError(409, 'already_used', 'You already used this code');
    throw e;
  }
  // take a seat atomically (respects the user limit and expiry)
  const seat = await PromoCode.findOneAndUpdate(
    {
      _id: promo._id,
      active: true,
      $and: [
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
        { $or: [{ maxUses: 0 }, { $expr: { $lt: ['$uses', '$maxUses'] } }] },
      ],
    },
    { $inc: { uses: 1 } },
    { new: true }
  );
  if (!seat) {
    await PromoRedemption.deleteOne({ userId: req.user._id, promoId: promo._id });
    throw new ApiError(410, 'fully_used', 'This code has just been fully used');
  }

  const updated = await User.findByIdAndUpdate(
    req.user._id,
    { $inc: { balance: promo.reward, totalEarned: promo.reward, adsWatched: 1, 'daily.adsCount': 1 } },
    { new: true }
  );
  await credit(req.user._id, 'promo', promo.reward, `Promo code ${promo.code}`);
  await applyReferralRewards(updated, config.mainAdReward);
  res.json({ ok: true, reward: promo.reward, balance: updated.balance });
});

/* ------------------------------ channel bonus ------------------------------ */
router.post('/channel/claim', async (req, res) => {
  if (!config.channelUsername) throw new ApiError(404, 'no_channel', 'No channel configured');
  if (req.user.channelClaimed) throw new ApiError(409, 'already_claimed', 'You already got this bonus');

  // Verify membership when the bot can see the channel (add the bot as a channel admin for this).
  // If Telegram cannot verify (bot not in the channel) the one-time +pts is still given after the link was opened.
  const r = await tg('getChatMember', { chat_id: `@${config.channelUsername}`, user_id: req.user.telegramId });
  if (r?.ok) {
    const st = r.result?.status;
    if (!['member', 'administrator', 'creator', 'restricted'].includes(st))
      throw new ApiError(409, 'not_joined', 'Join the channel first, then tap Claim');
  }

  const reward = config.channelReward;
  const updated = await User.findOneAndUpdate(
    { _id: req.user._id, channelClaimed: false },
    { $set: { channelClaimed: true }, $inc: { balance: reward, totalEarned: reward } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'already_claimed', 'You already got this bonus');
  await credit(req.user._id, 'channel', reward, 'Joined official channel');
  res.json({ ok: true, reward, balance: updated.balance });
});

export default router;
