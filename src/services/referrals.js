import { config } from '../config.js';
import { User, Transaction } from '../models/index.js';
import { sendMessage, escapeHtml } from '../lib/telegram.js';

/**
 * Called right after a user earned `reward` points from an ad.
 *  - lifetime commission: commissionRate of every ad reward goes to the inviter's bonus balance
 *  - activation: once the friend watched `referralActivationAds` ads the inviter gets `referralBonus`
 */
export async function applyReferralRewards(user, reward) {
  if (!user.invitedBy) return;
  const referrer = await User.findOne({ telegramId: user.invitedBy });
  if (!referrer || referrer.banned) return;

  if (config.commissionRate > 0) {
    const commission = Math.max(1, Math.floor(reward * config.commissionRate));
    await User.updateOne({ _id: referrer._id }, { $inc: { bonusBalance: commission } });
    await User.updateOne({ _id: user._id }, { $inc: { commissionGenerated: commission } });
  }

  if (!user.referralActivated && user.adsWatched >= config.referralActivationAds) {
    // flip the flag atomically so the bonus can only be paid once
    const flipped = await User.findOneAndUpdate(
      { _id: user._id, referralActivated: false },
      { $set: { referralActivated: true } }
    );
    if (flipped) {
      await User.updateOne({ _id: referrer._id }, { $inc: { bonusBalance: config.referralBonus } });
      await Transaction.create({
        userId: referrer._id,
        type: 'referral_bonus',
        amount: config.referralBonus,
        note: `Friend ${user.firstName || user.telegramId} became active`,
      });
      sendMessage(
        referrer.telegramId,
        `🎉 Your friend <b>${escapeHtml(user.firstName || 'a friend')}</b> watched ${config.referralActivationAds} ads! ` +
          `<b>+${config.referralBonus} pts</b> bonus is waiting - open the app and tap <b>Claim Bonus</b>.`
      );
    }
  }
}
