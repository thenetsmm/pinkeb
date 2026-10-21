import { config } from '../config.js';
import { User } from '../models/index.js';
import { ApiError } from '../middleware/auth.js';

/** Piggy bank = a 10-minute auto-mining timer that lives on the server (survives refresh / reinstall). */
export async function piggyState(user) {
  let started = user.piggy?.startedAt;
  if (!started) {
    const u = await User.findOneAndUpdate(
      { _id: user._id, 'piggy.startedAt': null },
      { $set: { 'piggy.startedAt': new Date() } },
      { new: true }
    );
    started = (u || (await User.findById(user._id))).piggy?.startedAt || new Date();
  }
  const elapsed = (Date.now() - new Date(started).getTime()) / 1000;
  const remainingSec = Math.max(0, Math.ceil(config.piggyCycleSeconds - elapsed));
  return {
    cycleSec: config.piggyCycleSeconds,
    remainingSec,
    ready: remainingSec === 0,
    base: config.piggyBase,
    boosted: config.piggyBoosted,
  };
}

export const isPiggyReady = async (user) => (await piggyState(user)).ready;

/** Atomically empties the piggy bank (only when it is full) and pays `amount`. Restarts the timer. */
export async function claimPiggy(user, amount) {
  const full = new Date(Date.now() - config.piggyCycleSeconds * 1000);
  const updated = await User.findOneAndUpdate(
    { _id: user._id, 'piggy.startedAt': { $lte: full } },
    { $set: { 'piggy.startedAt': new Date() }, $inc: { balance: amount, totalEarned: amount } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'not_ready', 'The piggy bank is not full yet');
  return updated;
}
