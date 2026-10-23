import { config } from '../config.js';
import { User, Transaction, Withdrawal, PayoutProof } from '../models/index.js';
import { sendMessage, escapeHtml, tg } from '../lib/telegram.js';

export async function notifyAdminsNewWithdrawal(w, user) {
  const text =
    `💸 <b>New withdrawal request</b>\n\n` +
    `User: ${escapeHtml(user.firstName || '')} ${user.username ? '@' + escapeHtml(user.username) : ''} (<code>${user.telegramId}</code>)\n` +
    `Amount: <b>${w.amountKs} Ks</b> (${w.points} pts)\n` +
    `Method: ${escapeHtml(w.method)}\n` +
    `Account: <code>${escapeHtml(w.account)}</code>\n` +
    `Name: ${escapeHtml(w.accountName)}\n` +
    `ID: <code>${w._id}</code>`;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `wd:approve:${w._id}` },
        { text: '❌ Reject', callback_data: `wd:reject:${w._id}` },
      ],
    ],
  };
  await Promise.all(config.adminIds.map((id) => sendMessage(id, text, { reply_markup })));
}

/**
 * Approves / rejects a pending withdrawal (atomic, can only be resolved once).
 * Rejecting refunds the points.
 */
export async function resolveWithdrawal(id, action, reason = '', { refund = true } = {}) {
  const status = action === 'approve' ? 'success' : 'rejected';
  const w = await Withdrawal.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status, resolvedAt: new Date(), reason: status === 'rejected' ? String(reason || '').slice(0, 200) : '' } },
    { new: true }
  );
  if (!w) return null;

  if (status === 'rejected' && refund) {
    await User.updateOne({ _id: w.userId }, { $inc: { balance: w.points } });
    await Transaction.create({ userId: w.userId, type: 'withdraw_refund', amount: w.points, note: 'Withdrawal rejected' });
  }

  if (status === 'success') publishProof(w); // fire and forget

  await sendMessage(
    w.telegramId,
    status === 'success'
      ? `✅ Your withdrawal of <b>${w.amountKs} Ks</b> via ${escapeHtml(w.method)} has been sent. Thank you!`
      : refund
        ? `❌ Your withdrawal of <b>${w.amountKs} Ks</b> was rejected and <b>${w.points} pts</b> were returned to your balance.${w.reason ? `\nReason: ${escapeHtml(w.reason)}` : ''}\nContact support if you need help.`
        : `❌ Your withdrawal of <b>${w.amountKs} Ks</b> was rejected.${w.reason ? `\nReason: ${escapeHtml(w.reason)}` : ''}`
  );
  return w;
}

/* ---------------------------- public proof of payment ---------------------------- */
const maskName = (n = '') => {
  const t = String(n).trim();
  return t ? t.slice(0, 1) + '***' : 'User';
};
const maskAccount = (a = '') => {
  const d = String(a).replace(/\s/g, '');
  return d.length > 5 ? d.slice(0, 2) + '•'.repeat(Math.max(3, d.length - 5)) + d.slice(-3) : '•••';
};

/** Records a paid withdrawal as a public, masked proof and posts it to the proof channel. Never throws. */
export async function publishProof(w) {
  try {
    const ref = 'WD-' + String(w._id).slice(-5).toUpperCase();
    const user = await User.findById(w.userId).select('firstName username').lean();
    const proof = {
      ref,
      name: maskName(user?.firstName || user?.username || w.accountName),
      account: maskAccount(w.account),
      amountKs: w.amountKs,
      method: w.method,
      paidAt: new Date(),
    };
    await PayoutProof.updateOne({ ref }, { $setOnInsert: proof }, { upsert: true });
    if (config.proofChannel) {
      const chat = /^-?\d+$/.test(config.proofChannel) ? config.proofChannel : '@' + config.proofChannel.replace('@', '');
      await tg('sendMessage', {
        chat_id: chat,
        parse_mode: 'HTML',
        text:
          `✅ <b>Payment Sent</b>\n\n` +
          `👤 User: ${escapeHtml(proof.name)}\n` +
          `💰 Amount: <b>${w.amountKs.toLocaleString('en-US')} Ks</b>\n` +
          `🏦 Method: ${escapeHtml(w.method)}\n` +
          `📱 Account: ${escapeHtml(proof.account)}\n` +
          `🧾 Ref: ${ref}\n` +
          `🕒 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      });
    }
  } catch (err) {
    console.warn('[proof] failed:', err.message);
  }
}

/** Boot-time: withdrawals paid before this feature existed also appear on the proof page (no channel post). */
export async function backfillProofs() {
  try {
    const list = await Withdrawal.find({ status: 'success' }).sort({ resolvedAt: -1 }).limit(200).lean();
    for (const w of list) {
      const ref = 'WD-' + String(w._id).slice(-5).toUpperCase();
      if (await PayoutProof.exists({ ref })) continue;
      const user = await User.findById(w.userId).select('firstName username').lean();
      await PayoutProof.updateOne({ ref }, { $setOnInsert: { ref, name: maskName(user?.firstName || user?.username || w.accountName), account: maskAccount(w.account), amountKs: w.amountKs, method: w.method, paidAt: w.resolvedAt || w.createdAt } }, { upsert: true });
    }
  } catch (err) {
    console.warn('[proof] backfill failed:', err.message);
  }
}
