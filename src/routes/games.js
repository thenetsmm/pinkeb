import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ApiError } from '../middleware/auth.js';
import { AdSession } from '../models/index.js';
import { applyReferralRewards } from '../services/referrals.js';
import {
  GAMES, MYSTERY, rollMystery, gamesState, leaderboard, txn,
  assertCanPlayWithAd, consumeGameSession, applyAdPlay, applyPaidPlay, usedToday,
} from '../services/games.js';

// Mounted at /api/games, AFTER the auth middleware (req.user / req.today exist).
const router = Router();

router.get('/', (req, res) => res.json(gamesState(req.user)));

router.get('/leaderboard', async (req, res) => {
  res.json(await leaderboard(req.user, req.today));
});

/* ----------------------- Lucky Spin & Scratch Card ----------------------- */
for (const game of Object.keys(GAMES)) {
  const g = GAMES[game];

  // 1) the player taps "Watch Ad": open an ad session
  router.post(`/${game}/start`, async (req, res) => {
    assertCanPlayWithAd(req.user, game);
    await AdSession.updateMany({ userId: req.user._id, status: 'pending' }, { $set: { status: 'expired' } });
    const session = await AdSession.create({
      userId: req.user._id,
      kind: 'game',
      game,
      reward: 0,
      minSeconds: config.gameAdSeconds,
      needsConfirm: config.requireProviderConfirm && !!config.adsgramRewardSecret,
    });
    res.json({ sessionId: String(session._id), seconds: config.gameAdSeconds });
  });

  // 2) after the ad (or with points when the free plays are used up): roll + pay the prize right away.
  //    The client only animates the result, so closing the pop-up can never lose a prize.
  router.post(`/${game}/play`, async (req, res) => {
    const user = req.user;

    // paid replay (only the spin wheel offers it)
    if (req.body?.paid === true) {
      if (game !== 'spin') throw new ApiError(400, 'not_available', 'Come back tomorrow for more cards');
      if (usedToday(user, game) < g.limit()) throw new ApiError(409, 'free_left', 'Use your free spins first');
      const cost = config.spinPaidCost;
      const index = g.roll();
      const prize = g.values[index];
      const updated = await applyPaidPlay(user, cost, prize);
      if (!updated) throw new ApiError(400, 'insufficient', `Not enough points. You need ${cost} pts.`);
      await txn(user._id, 'game_cost', -cost, `${g.label} (paid spin)`);
      if (prize > 0) await txn(user._id, g.txType, prize, `${g.label} prize`);
      return res.json({ ok: true, paid: true, index, prize, cost, balance: updated.balance });
    }

    // free play after an ad
    assertCanPlayWithAd(user, game);
    await consumeGameSession(user, req.body?.sessionId, game);
    const index = g.roll();
    const prize = g.values[index];
    const updated = await applyAdPlay(user, game, prize, req.today);
    if (!updated) throw new ApiError(429, 'cooldown', 'Please wait for the cooldown to finish');
    if (prize > 0) await txn(user._id, g.txType, prize, `${g.label} prize`);
    // the ad impression counts like any other ad view (referral commission / activation)
    await applyReferralRewards(updated, config.mainAdReward);

    const state = gamesState(updated)[game];
    res.json({ ok: true, paid: false, index, prize, balance: updated.balance, left: state.left, cooldownSec: state.cooldownSec });
  });
}

/* ------------------------------- Mystery Box ------------------------------- */
// Costs points (no ad, no cooldown). The prize is paid immediately; the pop-up is just the show.
router.post('/mystery/play', async (req, res) => {
  const cost = config.mysteryCost;
  const prize = rollMystery();
  const updated = await applyPaidPlay(req.user, cost, prize);
  if (!updated) throw new ApiError(400, 'insufficient', `Not enough points. You need ${cost} pts.`);
  await txn(req.user._id, 'game_cost', -cost, 'Mystery Box (cost)');
  await txn(req.user._id, 'game_mystery', prize, 'Mystery Box prize');

  // the two boxes the player did not pick: the other two values, shuffled
  const others = [...MYSTERY];
  others.splice(others.indexOf(prize), 1);
  if (crypto.randomInt(2)) others.reverse();
  res.json({ ok: true, prize, others, cost, balance: updated.balance });
});

export default router;
