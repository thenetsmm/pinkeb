import { config } from '../config.js';
import { User, Transaction, Withdrawal } from '../models/index.js';
import { sendMessage, escapeHtml } from '../lib/telegram.js';

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
export async function resolveWithdrawal(id, action, reason = '') {
  const status = action === 'approve' ? 'success' : 'rejected';
  const w = await Withdrawal.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status, resolvedAt: new Date(), reason: status === 'rejected' ? String(reason || '').slice(0, 200) : '' } },
    { new: true }
  );
  if (!w) return null;

  if (status === 'rejected') {
    await User.updateOne({ _id: w.userId }, { $inc: { balance: w.points } });
    await Transaction.create({ userId: w.userId, type: 'withdraw_refund', amount: w.points, note: 'Withdrawal rejected' });
  }

  await sendMessage(
    w.telegramId,
    status === 'success'
      ? `✅ Your withdrawal of <b>${w.amountKs} Ks</b> via ${escapeHtml(w.method)} has been sent. Thank you!`
      : `❌ Your withdrawal of <b>${w.amountKs} Ks</b> was rejected and <b>${w.points} pts</b> were returned to your balance. ${w.reason ? `\nReason: ${escapeHtml(w.reason)}\n` : ''}Contact support if you need help.`
  );
  return w;
}
