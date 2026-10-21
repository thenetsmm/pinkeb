import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { auth, ApiError } from '../middleware/auth.js';
import { User, Offer, AdSession, Transaction, Withdrawal } from '../models/index.js';
import { buildState, streakInfo } from '../services/state.js';
import { applyReferralRewards } from '../services/referrals.js';
import { notifyAdminsNewWithdrawal } from '../services/withdrawals.js';

import gamesRoutes from './games.js';
import extrasRoutes from './extras.js';

const router = Router();

/* ------------------------- public: AdsGram reward callback ------------------------- */
// Set in AdsGram "Reward URL":  https://<backend>/api/ads/adsgram-reward?secret=<ADSGRAM_REWARD_SECRET>&userid=[userId]
router.get('/ads/adsgram-reward', async (req, res) => {
  const { secret, userid } = req.query;
  if (!config.adsgramRewardSecret || secret !== config.adsgramRewardSecret) throw new ApiError(401, 'unauthorized');
  const user = await User.findOne({ telegramId: Number(userid) }).select('_id');
  if (user) {
    await AdSession.findOneAndUpdate(
      { userId: user._id, status: 'pending', needsConfirm: true, providerConfirmed: false },
      { $set: { providerConfirmed: true } },
      { sort: { createdAt: -1 } }
    );
  }
  res.json({ ok: true });
});

/* everything below requires a Telegram user */
router.use(auth);

const credit = (userId, type, amount, note) => Transaction.create({ userId, type, amount, note });

router.use('/games', gamesRoutes);
router.use(extrasRoutes);

/* ----------------------------------- state ----------------------------------- */
router.get('/me', async (req, res) => {
  res.json(await buildState(req.user, req.today));
});

/* --------------------------------- daily check-in --------------------------------- */
router.post('/checkin', async (req, res) => {
  const user = req.user;
  if (user.daily?.checkin) throw new ApiError(409, 'already_claimed', 'You already checked in today');

  const info = streakInfo(user);
  const day = info.nextDay;
  const reward = config.streakRewards[day - 1];

  const updated = await User.findOneAndUpdate(
    { _id: user._id, 'daily.date': req.today, 'daily.checkin': false },
    {
      $set: { 'daily.checkin': true, 'streak.count': day, 'streak.lastDate': req.today },
      $inc: { balance: reward, totalEarned: reward },
    },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'already_claimed', 'You already checked in today');

  await credit(user._id, 'checkin', reward, `Daily check-in (Day ${day})`);
  res.json({ ok: true, reward, day, balance: updated.balance });
});

/* ------------------------------------ ads ------------------------------------ */
router.post('/ads/start', async (req, res) => {
  const user = req.user;
  const { offerId } = req.body || {};
  const task = req.body?.task === 'ads5' && !offerId ? 'ads5' : '';

  if ((user.daily?.adsCount || 0) >= config.dailyAdCap)
    throw new ApiError(429, 'daily_limit', 'Daily ad limit reached. Come back tomorrow!');

  let reward = config.mainAdReward;
  let minSeconds = config.mainAdSeconds;
  let kind = 'main';
  let offer = null;

  if (offerId) {
    if (!mongoose.isValidObjectId(offerId)) throw new ApiError(400, 'invalid_offer');
    offer = await Offer.findOne({ _id: offerId, active: true });
    if (!offer) throw new ApiError(404, 'invalid_offer', 'Offer not found');
    const doneToday = await AdSession.countDocuments({
      userId: user._id, offerId: offer._id, status: 'completed', day: req.today,
    });
    if (doneToday >= offer.dailyLimit) throw new ApiError(429, 'offer_limit', 'No more of this offer today');
    reward = offer.reward;
    minSeconds = offer.seconds;
    kind = 'offer';
  }

  // an unfinished older session is dropped
  await AdSession.updateMany({ userId: user._id, status: 'pending' }, { $set: { status: 'expired' } });

  const isLink = !!offer?.url;
  const session = await AdSession.create({
    userId: user._id,
    kind,
    task,
    offerId: offer?._id || null,
    reward,
    minSeconds,
    url: offer?.url || '',
    needsConfirm: config.requireProviderConfirm && !isLink && !!config.adsgramRewardSecret,
  });

  res.json({ sessionId: String(session._id), seconds: minSeconds, reward, url: offer?.url || null });
});

router.post('/ads/complete', async (req, res) => {
  const user = req.user;
  const { sessionId } = req.body || {};
  if (!mongoose.isValidObjectId(sessionId)) throw new ApiError(400, 'invalid_session');

  const s = await AdSession.findOne({ _id: sessionId, userId: user._id });
  if (!s || s.status !== 'pending') throw new ApiError(400, 'invalid_session', 'This ad session is no longer valid');

  const elapsed = (Date.now() - s.createdAt.getTime()) / 1000;
  if (elapsed > 30 * 60) {
    await AdSession.updateOne({ _id: s._id }, { $set: { status: 'expired' } });
    throw new ApiError(400, 'expired', 'Ad session expired');
  }
  if (elapsed < s.minSeconds - 1) throw new ApiError(429, 'too_early', 'Please watch the whole ad to earn points');
  if (s.needsConfirm && !s.providerConfirmed) throw new ApiError(409, 'awaiting_provider', 'Waiting for ad confirmation');

  // gate: the session can be paid exactly once
  const gate = await AdSession.findOneAndUpdate(
    { _id: s._id, status: 'pending' },
    { $set: { status: 'completed', completedAt: new Date(), day: req.today } }
  );
  if (!gate) throw new ApiError(400, 'invalid_session');

  const updated = await User.findOneAndUpdate(
    { _id: user._id, 'daily.date': req.today, 'daily.adsCount': { $lt: config.dailyAdCap } },
    {
      $inc: {
        balance: s.reward,
        totalEarned: s.reward,
        adsWatched: 1,
        'daily.adsCount': 1,
        // only ads watched from the Daily Task card count towards "Watch 5 ads"
        ...(s.task === 'ads5' ? { 'daily.taskAds': 1 } : {}),
      },
      $set: { lastAdAt: new Date() },
    },
    { new: true }
  );
  if (!updated) throw new ApiError(429, 'daily_limit', 'Daily ad limit reached. Come back tomorrow!');

  await credit(user._id, s.kind === 'offer' ? 'offer' : 'ad', s.reward, s.kind === 'offer' ? 'Offer reward' : 'Watched an ad');
  await applyReferralRewards(updated, s.reward);

  res.json({ ok: true, reward: s.reward, balance: updated.balance, adsWatched: updated.adsWatched, taskAds: updated.daily?.taskAds || 0 });
});

/* ---------------------------------- daily tasks ---------------------------------- */
router.post('/tasks/ads/claim', async (req, res) => {
  const reward = config.adsTaskReward;
  const updated = await User.findOneAndUpdate(
    { _id: req.user._id, 'daily.date': req.today, 'daily.ads5': false, 'daily.taskAds': { $gte: config.adsTaskTarget } },
    { $set: { 'daily.ads5': true }, $inc: { balance: reward, totalEarned: reward } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'not_ready', `Watch ${config.adsTaskTarget} ads first`);
  await credit(req.user._id, 'task_ads', reward, `Watched ${config.adsTaskTarget} ads`);
  res.json({ ok: true, reward, balance: updated.balance });
});

router.post('/tasks/invite/claim', async (req, res) => {
  const active = await User.countDocuments({ invitedBy: req.user.telegramId, referralActivated: true });
  if (active < 1) throw new ApiError(409, 'not_ready', 'Invite a friend who watches ads first');
  const reward = config.inviteTaskReward;
  const updated = await User.findOneAndUpdate(
    { _id: req.user._id, inviteTaskClaimed: false },
    { $set: { inviteTaskClaimed: true }, $inc: { balance: reward, totalEarned: reward } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'already_claimed', 'Already claimed');
  await credit(req.user._id, 'task_invite', reward, 'Invite a friend');
  res.json({ ok: true, reward, balance: updated.balance });
});

/* ---------------------------------- referrals ---------------------------------- */
router.get('/referrals', async (req, res) => {
  const friends = await User.find({ invitedBy: req.user.telegramId })
    .sort({ createdAt: -1 })
    .limit(100)
    .select('firstName username referralActivated adsWatched commissionGenerated createdAt')
    .lean();
  res.json({
    friends: friends.map((f) => ({
      name: f.firstName || (f.username ? '@' + f.username : 'Friend'),
      active: f.referralActivated,
      adsWatched: f.adsWatched,
      earned: f.commissionGenerated,
      joinedAt: f.createdAt,
    })),
  });
});

router.post('/referrals/claim', async (req, res) => {
  // move bonusBalance -> balance atomically (pipeline update), returns the doc *before* the change
  const before = await User.findOneAndUpdate(
    { _id: req.user._id, bonusBalance: { $gt: 0 } },
    [
      {
        $set: {
          balance: { $add: ['$balance', '$bonusBalance'] },
          totalEarned: { $add: ['$totalEarned', '$bonusBalance'] },
          bonusBalance: 0,
        },
      },
    ],
    { new: false }
  );
  if (!before) throw new ApiError(409, 'nothing_to_claim', 'No bonus to claim yet');
  await credit(req.user._id, 'bonus_claim', before.bonusBalance, 'Referral bonus claimed');
  res.json({ ok: true, claimed: before.bonusBalance, balance: before.balance + before.bonusBalance });
});

/* ----------------------------------- withdraw ----------------------------------- */
router.post('/withdraw', async (req, res) => {
  const user = req.user;
  const { method, account, accountName } = req.body || {};
  const points = Math.floor(Number(req.body?.points));

  if (!config.withdrawMethods.includes(method)) throw new ApiError(400, 'invalid_method', 'Choose a payout method');
  const acc = String(account || '').trim();
  const name = String(accountName || '').trim();
  if (!/^(\+?959|09)\d{7,10}$/.test(acc)) throw new ApiError(400, 'invalid_account', 'Enter a valid Myanmar phone number (09…)');
  if (name.length < 2 || name.length > 60) throw new ApiError(400, 'invalid_name', 'Enter the account name');

  const minPoints = config.minWithdraw * config.ptsPerKs;
  if (!Number.isFinite(points) || points < minPoints)
    throw new ApiError(400, 'below_minimum', `Minimum payout is ${config.minWithdraw} Ks`);
  if (await Withdrawal.exists({ userId: user._id, status: 'pending' }))
    throw new ApiError(409, 'pending_exists', 'You already have a pending withdrawal');

  const updated = await User.findOneAndUpdate(
    { _id: user._id, balance: { $gte: points } },
    { $inc: { balance: -points } },
    { new: true }
  );
  if (!updated) throw new ApiError(400, 'insufficient', 'Not enough points');

  let w;
  try {
    w = await Withdrawal.create({
      userId: user._id,
      telegramId: user.telegramId,
      points,
      amountKs: Math.floor(points / config.ptsPerKs),
      method,
      account: acc,
      accountName: name,
    });
  } catch (err) {
    await User.updateOne({ _id: user._id }, { $inc: { balance: points } }); // refund on failure
    throw err;
  }
  await credit(user._id, 'withdraw', -points, `Withdrawal via ${method}`);
  notifyAdminsNewWithdrawal(w, user).catch(() => {});
  res.json({ ok: true, balance: updated.balance, withdrawalId: String(w._id) });
});

/* ----------------------------------- history ----------------------------------- */
router.get('/history', async (req, res) => {
  const [withdrawals, transactions] = await Promise.all([
    Withdrawal.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(30).lean(),
    Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(40).lean(),
  ]);
  res.json({
    adsWatched: req.user.adsWatched,
    totalEarned: req.user.totalEarned,
    withdrawals: withdrawals.map((w) => ({
      id: String(w._id), amountKs: w.amountKs, points: w.points, method: w.method, status: w.status, reason: w.reason || '', createdAt: w.createdAt,
    })),
    transactions: transactions.map((t) => ({
      id: String(t._id), type: t.type, amount: t.amount, note: t.note, createdAt: t.createdAt,
    })),
  });
});

export default router;
