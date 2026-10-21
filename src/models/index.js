import mongoose from 'mongoose';
const { Schema } = mongoose;

/* ---------------------------------- User ---------------------------------- */
const userSchema = new Schema(
  {
    telegramId: { type: Number, required: true, unique: true },
    firstName: String,
    lastName: String,
    username: String,
    photoUrl: String,
    languageCode: String,

    balance: { type: Number, default: 0, min: 0 }, // spendable points
    bonusBalance: { type: Number, default: 0, min: 0 }, // referral bonus waiting to be claimed
    totalEarned: { type: Number, default: 0 },
    adsWatched: { type: Number, default: 0 },

    // referral
    invitedBy: { type: Number, default: null, index: true }, // telegramId of the inviter
    referralActivated: { type: Boolean, default: false }, // friend watched enough ads
    commissionGenerated: { type: Number, default: 0 }, // lifetime commission this user produced for the inviter
    inviteTaskClaimed: { type: Boolean, default: false },

    streak: {
      count: { type: Number, default: 0 },
      lastDate: { type: String, default: null }, // YYYY-MM-DD of last check-in
    },

    // reset at the start of every day (see middleware/auth.js)
    daily: {
      date: { type: String, default: null },
      adsCount: { type: Number, default: 0 },
      checkin: { type: Boolean, default: false },
      ads5: { type: Boolean, default: false },
    },

    lastAdAt: Date,
    banned: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/* -------------------------------- AdSession -------------------------------- */
const adSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['main', 'offer'], required: true },
    offerId: { type: Schema.Types.ObjectId, ref: 'Offer', default: null },
    reward: { type: Number, required: true },
    minSeconds: { type: Number, required: true },
    url: String,
    needsConfirm: { type: Boolean, default: false },
    providerConfirmed: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'completed', 'expired'], default: 'pending' },
    day: String,
    completedAt: Date,
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 3 }, // auto-clean after 3 days
  },
  { versionKey: false }
);
adSessionSchema.index({ userId: 1, status: 1 });
adSessionSchema.index({ userId: 1, offerId: 1, day: 1 });

/* ------------------------------- Transaction ------------------------------- */
const transactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true }, // ad, offer, checkin, task_ads5, task_invite, referral_bonus, bonus_claim, withdraw, withdraw_refund
    amount: { type: Number, required: true }, // signed
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/* ------------------------------- Withdrawal -------------------------------- */
const withdrawalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true },
    points: { type: Number, required: true },
    amountKs: { type: Number, required: true },
    method: { type: String, required: true },
    account: { type: String, required: true },
    accountName: { type: String, required: true },
    status: { type: String, enum: ['pending', 'success', 'rejected'], default: 'pending', index: true },
    resolvedAt: Date,
  },
  { timestamps: true }
);

/* ---------------------------------- Offer ---------------------------------- */
const offerSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    reward: { type: Number, required: true },
    seconds: { type: Number, default: 15 },
    url: { type: String, default: '' }, // if set: opened as a link, otherwise shown as a video ad
    dailyLimit: { type: Number, default: 3 },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
export const AdSession = mongoose.model('AdSession', adSessionSchema);
export const Transaction = mongoose.model('Transaction', transactionSchema);
export const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
export const Offer = mongoose.model('Offer', offerSchema);
