import { DailyStat, SecurityLog } from '../models/index.js';
import { dayKey } from '../lib/days.js';

/** Counts one watched ad per placement (main, task, spin, scratch, piggy, promo, offer). Never throws. */
export function bumpAd(placement) {
  return DailyStat.updateOne(
    { day: dayKey() },
    { $inc: { [`ads.${placement}`]: 1, adsTotal: 1 } },
    { upsert: true }
  ).catch(() => {});
}
export const bumpDau = () => DailyStat.updateOne({ day: dayKey() }, { $inc: { dau: 1 } }, { upsert: true }).catch(() => {});

export const logSecurity = (type, user, detail = {}) =>
  SecurityLog.create({ type, userId: user?._id, telegramId: user?.telegramId, detail }).catch(() => {});
