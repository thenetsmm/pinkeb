import { config } from '../config.js';
import { User, Transaction, Withdrawal, Proof } from '../models/index.js';
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

const maskName = (n = '') =>
  String(n).trim().split(/\s+/).filter(Boolean).map((w) => w[0] + '*'.repeat(Math.min(Math.max(w.length - 1, 2), 5))).join(' ') || '***';
const maskAccount = (a = '') => {
  const d = String(a).replace(/\s/g, '');
  return d.length <= 5 ? '*****' : d.slice(0, 2) + '*'.repeat(Math.max(d.length - 5, 3)) + d.slice(-3);
};

/** Saves a masked proof and posts it to the public proof channel (never throws). */
export async function publishPayoutProof(w) {
  try {
    const proof = await Proof.findOneAndUpdate(
      { withdrawalId: w._id },
      { $setOnInsert: { withdrawalId: w._id, name: maskName(w.accountName), account: maskAccount(w.account), method: w.method, amountKs: w.amountKs } },
      { upsert: true, new: true }
    );
    if (!config.proofChannel || proof.channelPosted) return proof;
    const text =
      `✅ <b>Payment Successful</b>\n\n` +
      `👤 Name: <b>${escapeHtml(proof.name)}</b>\n` +
      `📱 Account: <code>${escapeHtml(proof.account)}</code>\n` +
      `🏦 Method: ${escapeHtml(proof.method)}\n` +
      `💰 Amount: <b>${proof.amountKs.toLocaleString('en-US')} Ks</b>\n` +
      `🕒 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n` +
      `🧾 Ref: <code>${String(w._id).slice(-8).toUpperCase()}</code>\n\n` +
      `Paid by @${escapeHtml(config.botUsername)}`;
    const r = await sendMessage(`@${config.proofChannel}`, text);
    if (r?.ok) await Proof.updateOne({ _id: proof._id }, { $set: { channelPosted: true } });
    return proof;
  } catch (err) {
    console.warn('[proof] failed:', err.message);
    return null;
  }
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

  if (status === 'success') await publishPayoutProof(w);

  if (status === 'rejected' && refund) {
    await User.updateOne({ _id: w.userId }, { $inc: { balance: w.points } });
    await Transaction.create({ userId: w.userId, type: 'withdraw_refund', amount: w.points, note: 'Withdrawal rejected' });
  }

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
