import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { tg, sendMessage, escapeHtml, webAppUrl } from '../lib/telegram.js';
import { ensureUser, parseReferral } from '../services/users.js';
import { resolveWithdrawal } from '../services/withdrawals.js';
import { Withdrawal, PromoCode, User } from '../models/index.js';
import { handleAiMessage } from '../services/aiChat.js';

const router = Router();

/**
 * Telegram webhook. Handles:
 *  - /start [invite<ID>]  -> registers the user (+ referral) and shows an "Open app" button
 *  - admin inline buttons for withdrawals
 */
router.post('/webhook', async (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== config.webhookSecret) return res.sendStatus(401);
  res.sendStatus(200); // answer fast, Telegram retries on slow responses

  try {
    const update = req.body || {};
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
    else if (update.my_chat_member?.chat?.type === 'private') {
      // the user blocked / unblocked the bot
      const st = update.my_chat_member.new_chat_member?.status;
      await User.updateOne({ telegramId: update.my_chat_member.from.id }, { $set: { botBlocked: st === 'kicked' } });
    }
  } catch (err) {
    console.error('[bot] update failed:', err);
  }
});

async function onMessage(msg) {
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const text = (msg.text || '').trim();

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || null;
    const user = await ensureUser(msg.from, parseReferral(payload) ? payload : null);
    const url = webAppUrl();
    const invited = user.invitedBy ? '\n\n🎁 You were invited by a friend - watch 5 ads to unlock their bonus!' : '';
    await sendMessage(
      msg.chat.id,
      `👋 Welcome to <b>${escapeHtml(config.appName)}</b>, ${escapeHtml(msg.from.first_name || '')}!\n\nWatch ads, finish daily tasks and invite friends to earn points. Minimum payout is <b>${config.minWithdraw} Ks</b>.${invited}`,
      url ? { reply_markup: { inline_keyboard: [[{ text: `🚀 Open ${config.appName}`, web_app: { url } }]] } } : {}
    );
    return;
  }

  // ---- admin shortcuts ----
  // /promo CODE REWARD [MAX_USES] [HOURS]   e.g. /promo SHADOW20 20 100 24
  // /reject WITHDRAWAL_ID reason...
  if (config.adminIds.includes(msg.from.id) && text.startsWith('/proofsetup')) {
    // posts + pins the intro message in the proof channel (the bot must be an admin of that channel)
    if (!config.proofChannel) return sendMessage(msg.chat.id, 'Set PAYMENT_PROOF_CHANNEL in Render first.');
    const chat = /^-?\d+$/.test(config.proofChannel) ? config.proofChannel : '@' + config.proofChannel.replace('@', '');
    const r = await tg('sendMessage', {
      chat_id: chat,
      parse_mode: 'HTML',
      text: `📌 <b>${escapeHtml(config.appName)} - Payment Proofs</b>\n\nEvery withdrawal we pay is posted here automatically (names and numbers are partly hidden for privacy).\nMinimum payout ${config.minWithdraw} Ks · KBZ Pay / Wave Pay.\n\n🚀 Open the app: https://t.me/${config.botUsername}`,
    });
    if (r?.ok) await tg('pinChatMessage', { chat_id: chat, message_id: r.result.message_id, disable_notification: true });
    return sendMessage(msg.chat.id, r?.ok ? '✅ Intro posted and pinned.' : '❌ Could not post. Add the bot as an admin of the channel.');
  }

  if (config.adminIds.includes(msg.from.id) && (text.startsWith('/promo') || text.startsWith('/reject'))) {
    const [cmd, ...a] = text.split(/\s+/);
    if (cmd === '/promo') {
      const code = String(a[0] || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      const reward = Number(a[1]);
      if (!code || !(reward > 0)) return sendMessage(msg.chat.id, 'Usage: /promo CODE REWARD [MAX_USES] [HOURS] [ad]');
      const hours = Number(a[3]);
      const requireAd = a.slice(4).some((x) => x.toLowerCase() === 'ad'); // add the word "ad" at the end to make users watch an ad first
      const p = await PromoCode.findOneAndUpdate(
        { code },
        { $set: { reward, maxUses: Number(a[2]) || 0, expiresAt: hours > 0 ? new Date(Date.now() + hours * 3600_000) : null, active: true, uses: 0, requireAd } },
        { upsert: true, new: true }
      );
      return sendMessage(msg.chat.id, `✅ Promo <b>${escapeHtml(p.code)}</b>: +${p.reward} pts, ${p.maxUses || '∞'} uses${hours > 0 ? `, expires in ${hours}h` : ''}${requireAd ? ', ad required' : ', no ad'}`);
    }
    const [id, ...why] = a;
    if (!mongoose.isValidObjectId(id)) return sendMessage(msg.chat.id, 'Usage: /reject WITHDRAWAL_ID reason');
    const w = await resolveWithdrawal(id, 'reject', why.join(' '));
    return sendMessage(msg.chat.id, w ? '❌ Rejected and refunded.' : 'Not found or already handled.');
  }

  if (text === '/help' || text === '/support') {
    await sendMessage(msg.chat.id, `Need help? Contact @${escapeHtml(config.supportUsername)}`);
    return;
  }

  // anything else typed in the private chat goes to the AI support assistant
  await handleAiMessage(msg);
}

async function onCallback(cb) {
  const data = cb.data || '';
  const isAdmin = config.adminIds.includes(cb.from?.id);
  if (!data.startsWith('wd:')) return tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (!isAdmin) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not allowed', show_alert: true });

  const [, action, id] = data.split(':');
  if (!mongoose.isValidObjectId(id) || !['approve', 'reject'].includes(action))
    return tg('answerCallbackQuery', { callback_query_id: cb.id });

  const w = await resolveWithdrawal(id, action);
  await tg('answerCallbackQuery', {
    callback_query_id: cb.id,
    text: w ? (action === 'approve' ? 'Approved ✅' : 'Rejected ❌') : 'Already handled',
  });
  if (w && cb.message) {
    const done = await Withdrawal.findById(id).lean();
    await tg('editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      parse_mode: 'HTML',
      text: `${cb.message.text}\n\n<b>${done.status === 'success' ? '✅ APPROVED' : '❌ REJECTED'}</b> by ${escapeHtml(cb.from.first_name || String(cb.from.id))}`,
    });
  }
}

/** Registers the webhook + menu button at boot (needs BACKEND_URL / RENDER_EXTERNAL_URL). */
export async function setupBot() {
  if (!config.botToken) return console.warn('[bot] BOT_TOKEN missing - bot disabled');
  if (config.publicUrl) {
    const r = await tg('setWebhook', {
      url: `${config.publicUrl}/api/bot/webhook`,
      secret_token: config.webhookSecret,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false,
    });
    console.log('[bot] webhook:', r?.ok ? `set -> ${config.publicUrl}/api/bot/webhook` : 'FAILED');
  } else {
    console.warn('[bot] BACKEND_URL / RENDER_EXTERNAL_URL not set - webhook not registered');
  }
  const url = webAppUrl();
  if (url) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: config.appName, web_app: { url } } });
}

export default router;
