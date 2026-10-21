import { config } from '../config.js';
import { dayKey, yesterdayKey } from '../lib/days.js';
import { referralLink } from '../lib/telegram.js';
import { User, Offer, AdSession, Withdrawal } from '../models/index.js';

export function streakInfo(user) {
  const today = dayKey();
  const last = user.streak?.lastDate;
  const rewards = config.streakRewards;
  const cycle = rewards.length;
  const checkedToday = last === today;
  let effective = 0;
  if (last === today || last === yesterdayKey()) effective = user.streak?.count || 0;

  // after a full cycle the next check-in starts again at Day 1
  const nextDay = checkedToday ? null : effective >= cycle ? 1 : effective + 1;
  const checkedDays = !checkedToday && effective >= cycle ? 0 : effective;
  return {
    count: effective,
    checkedToday,
    checkedDays,
    nextDay,
    nextReward: nextDay ? rewards[nextDay - 1] : null,
    rewards,
  };
}

export async function referralCounts(user) {
  const [active, pending] = await Promise.all([
    User.countDocuments({ invitedBy: user.telegramId, referralActivated: true }),
    User.countDocuments({ invitedBy: user.telegramId, referralActivated: false }),
  ]);
  return { active, pending };
}

/** Full snapshot used by GET /api/me */
export async function buildState(user, today) {
  const [offers, offerCounts, refs, pendingWithdrawal] = await Promise.all([
    Offer.find({ active: true }).sort({ sort: 1, createdAt: 1 }).lean(),
    AdSession.aggregate([
      { $match: { userId: user._id, status: 'completed', day: today, offerId: { $ne: null } } },
      { $group: { _id: '$offerId', n: { $sum: 1 } } },
    ]),
    referralCounts(user),
    Withdrawal.exists({ userId: user._id, status: 'pending' }),
  ]);

  const doneByOffer = new Map(offerCounts.map((o) => [String(o._id), o.n]));
  const streak = streakInfo(user);
  const adsToday = user.daily?.adsCount || 0;
  const capLeft = Math.max(0, config.dailyAdCap - adsToday);

  return {
    user: {
      telegramId: user.telegramId,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      photoUrl: user.photoUrl,
    },
    balance: user.balance,
    balanceKs: Math.floor(user.balance / config.ptsPerKs),
    bonusBalance: user.bonusBalance,
    adsWatched: user.adsWatched,
    streak,
    daily: {
      checkin: { claimed: !!user.daily?.checkin, reward: streak.nextReward },
      ads: {
        count: Math.min(adsToday, config.adsTaskTarget),
        watchedToday: adsToday,
        target: config.adsTaskTarget,
        reward: config.adsTaskReward,
        claimed: !!user.daily?.ads5,
        ready: adsToday >= config.adsTaskTarget && !user.daily?.ads5,
      },
      invite: {
        reward: config.inviteTaskReward,
        claimed: !!user.inviteTaskClaimed,
        ready: refs.active > 0 && !user.inviteTaskClaimed,
      },
    },
    mainAd: { reward: config.mainAdReward, seconds: config.mainAdSeconds, remainingToday: capLeft },
    offers: offers.map((o) => {
      const done = doneByOffer.get(String(o._id)) || 0;
      return {
        id: String(o._id),
        title: o.title,
        reward: o.reward,
        seconds: o.seconds,
        isLink: !!o.url,
        remainingToday: Math.max(0, Math.min(o.dailyLimit - done, capLeft)),
      };
    }),
    referral: {
      link: referralLink(user.telegramId),
      ...refs,
      total: refs.active + refs.pending,
      activationAds: config.referralActivationAds,
      activationBonus: config.referralBonus,
      commissionRate: config.commissionRate,
      commissionExample: Math.max(1, Math.floor(config.mainAdReward * config.commissionRate)),
      bonus: user.bonusBalance,
    },
    withdraw: {
      min: config.minWithdraw,
      ptsPerKs: config.ptsPerKs,
      methods: config.withdrawMethods,
      hasPending: !!pendingWithdrawal,
    },
    config: {
      adsgramBlockId: config.adsgramBlockId,
      demoAds: config.allowDemoAds,
      supportUsername: config.supportUsername,
      botUsername: config.botUsername,
    },
  };
}
