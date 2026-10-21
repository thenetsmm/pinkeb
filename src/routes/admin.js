import { Router } from 'express';
import mongoose from 'mongoose';
import { adminOnly, ApiError } from '../middleware/auth.js';
import { User, Offer, Withdrawal, PromoCode } from '../models/index.js';
import { resolveWithdrawal } from '../services/withdrawals.js';

const router = Router();
router.use(adminOnly);

router.get('/stats', async (req, res) => {
  const [users, activeRefs, pending, paid] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ referralActivated: true }),
    Withdrawal.countDocuments({ status: 'pending' }),
    Withdrawal.aggregate([{ $match: { status: 'success' } }, { $group: { _id: null, ks: { $sum: '$amountKs' } } }]),
  ]);
  res.json({ users, activeReferrals: activeRefs, pendingWithdrawals: pending, paidKs: paid[0]?.ks || 0 });
});

router.get('/withdrawals', async (req, res) => {
  const status = ['pending', 'success', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  res.json(await Withdrawal.find({ status }).sort({ createdAt: -1 }).limit(100).lean());
});

router.post('/withdrawals/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!mongoose.isValidObjectId(id) || !['approve', 'reject'].includes(action)) throw new ApiError(400, 'bad_request');
  const w = await resolveWithdrawal(id, action, req.body?.reason);
  if (!w) throw new ApiError(409, 'already_resolved', 'Withdrawal not found or already resolved');
  res.json({ ok: true, status: w.status });
});

/* offers (Today's Offers list) */
router.get('/offers', async (req, res) => res.json(await Offer.find().sort({ sort: 1 }).lean()));

router.post('/offers', async (req, res) => {
  const { key, title, reward, seconds, url, dailyLimit, active, sort } = req.body || {};
  if (!key || !title || !(Number(reward) > 0)) throw new ApiError(400, 'bad_request', 'key, title and reward are required');
  const offer = await Offer.findOneAndUpdate(
    { key },
    { $set: { title, reward: Number(reward), seconds: Number(seconds) || 15, url: url || '', dailyLimit: Number(dailyLimit) || 3, active: active !== false, sort: Number(sort) || 0 } },
    { upsert: true, new: true }
  );
  res.json(offer);
});

/* promo codes: POST {code, reward, maxUses?, hours?} */
router.get('/promos', async (req, res) => res.json(await PromoCode.find().sort({ createdAt: -1 }).limit(100).lean()));
router.post('/promos', async (req, res) => {
  const { code, reward, maxUses, hours, active } = req.body || {};
  const c = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!c || !(Number(reward) > 0)) throw new ApiError(400, 'bad_request', 'code and reward are required');
  const promo = await PromoCode.findOneAndUpdate(
    { code: c },
    { $set: { reward: Number(reward), maxUses: Number(maxUses) || 0, expiresAt: Number(hours) > 0 ? new Date(Date.now() + Number(hours) * 3600_000) : null, active: active !== false } },
    { upsert: true, new: true }
  );
  res.json(promo);
});

router.post('/users/:telegramId/ban', async (req, res) => {
  const banned = req.body?.banned !== false;
  const u = await User.findOneAndUpdate({ telegramId: Number(req.params.telegramId) }, { $set: { banned } }, { new: true });
  if (!u) throw new ApiError(404, 'not_found');
  res.json({ ok: true, banned: u.banned });
});

export default router;
