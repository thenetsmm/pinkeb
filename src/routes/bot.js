import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { tg, sendMessage, escapeHtml, webAppUrl } from '../lib/telegram.js';
import { ensureUser, parseReferral } from '../services/users.js';
import { resolveWithdrawal } from '../services/withdrawals.js';
import { Withdrawal } from '../models/index.js';

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

  if (text === '/help' || text === '/support') {
    await sendMessage(msg.chat.id, `Need help? Contact @${escapeHtml(config.supportUsername)}`);
  }
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
      allowed_updates: ['message', 'callback_query'],
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
