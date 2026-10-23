import { config } from '../config.js';
import { User } from '../models/index.js';
import { ensureUser } from './users.js';
import { askAI, NoKeyError } from './ai.js';
import { tg } from '../lib/telegram.js';
import { dayKey } from '../lib/days.js';

/*
 * Chat part of the AI support bot. Built so that spam, outages and blocked users can never hurt the server:
 *  - messages are answered one at a time per user, and at most MAX_PARALLEL AI calls run at once
 *  - at most one message every MIN_GAP_MS per user (extra ones are dropped, never queued)
 *  - old messages (Telegram redelivery after downtime, > STALE_SECONDS) are dropped, so a backlog never turns into a flood
 *  - when the limit is hit / all keys are down the user is told ONCE, then ignored silently
 *  - a user who blocked the bot is remembered (botBlocked) and never causes a crash
 */
const STALE_SECONDS = 120;
const MIN_GAP_MS = 3000;
const MAX_PARALLEL = 6;
const NOTICE_GAP_MS = 30 * 60_000;

const busy = new Set();
const lastSeen = new Map(); // telegramId -> ms of last accepted message
const lastNotice = new Map(); // `${telegramId}:${kind}` -> ms
let running = 0;

setInterval(() => {
  const cut = Date.now() - 3600_000;
  for (const [k, t] of lastSeen) if (t < cut) lastSeen.delete(k);
  for (const [k, t] of lastNotice) if (t < cut) lastNotice.delete(k);
}, 10 * 60_000).unref();

/** Sends plain text. Never throws. A 403 means the user blocked the bot. */
export async function safeSend(chatId, telegramId, text) {
  try {
    const r = await tg('sendMessage', { chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true });
    if (r && r.ok === false && (r.error_code === 403 || r.error_code === 400)) {
      if (r.error_code === 403) await User.updateOne({ telegramId }, { $set: { botBlocked: true } }).catch(() => {});
      return false;
    }
    return !!r?.ok;
  } catch {
    return false;
  }
}

function noticeOnce(telegramId, kind, gapMs = NOTICE_GAP_MS) {
  const k = `${telegramId}:${kind}`;
  const now = Date.now();
  if ((lastNotice.get(k) || 0) > now - gapMs) return false;
  lastNotice.set(k, now);
  return true;
}

/** Takes one of the user's daily questions. Atomic, so parallel messages cannot go over the limit. */
async function takeQuestion(user) {
  if (!config.aiLimitEnabled) return true;
  const today = dayKey();
  const a = await User.updateOne({ _id: user._id, aiDay: today, aiCount: { $lt: config.aiDailyLimit } }, { $inc: { aiCount: 1 } });
  if (a.modifiedCount) return true;
  const b = await User.updateOne({ _id: user._id, aiDay: { $ne: today } }, { $set: { aiDay: today, aiCount: 1 } });
  return !!b.modifiedCount;
}
const giveBack = (user) => (config.aiLimitEnabled ? User.updateOne({ _id: user._id, aiCount: { $gt: 0 } }, { $inc: { aiCount: -1 } }).catch(() => {}) : null);

const clean = (s) =>
  String(s)
    .replace(/\*\*|__|`{1,3}|^#{1,6}\s*/gm, '')
    .trim()
    .slice(0, 1800);

export async function handleAiMessage(msg) {
  const text = (msg.text || '').trim();
  const from = msg.from;
  const chatId = msg.chat.id;
  if (!config.aiEnabled || !text || text.startsWith('/')) return;
  if (Date.now() / 1000 - (msg.date || 0) > STALE_SECONDS) return; // old message: drop

  const id = from.id;
  if (busy.has(id)) return; // still answering the previous one
  const now = Date.now();
  if (now - (lastSeen.get(id) || 0) < MIN_GAP_MS) {
    if (noticeOnce(id, 'slow', 60_000)) await safeSend(chatId, id, 'ခဏလေးစောင့်ပြီးမှ ထပ်မေးပေးပါဗျ 🙏');
    return;
  }
  lastSeen.set(id, now);

  if (text.length > config.aiMaxInput) {
    if (noticeOnce(id, 'long', 60_000)) await safeSend(chatId, id, `မေးခွန်းကို စာလုံး ${config.aiMaxInput} အောက်နဲ့ တိုတိုလေး ရေးပေးပါဗျ 🙏`);
    return;
  }
  if (running >= MAX_PARALLEL) {
    if (noticeOnce(id, 'busy', 60_000)) await safeSend(chatId, id, 'လက်ရှိ မေးသူများနေပါတယ်။ ခဏနေမှ ပြန်မေးပေးပါဗျ 🙏');
    return;
  }

  busy.add(id);
  running++;
  try {
    const user = (await User.findOne({ telegramId: id })) || (await ensureUser(from));
    if (user.banned) return;
    if (user.botBlocked) await User.updateOne({ _id: user._id }, { $set: { botBlocked: false } });

    if (!(await takeQuestion(user))) {
      if (noticeOnce(id, 'daily', 6 * 3600_000)) await safeSend(chatId, id, 'ယနေ့အတွက် မေးမြန်းခွင့် ပြည့်သွားပါပြီဗျ။ မနက်ဖြန်မှ ပြန်မေးပေးပါ 🙏 (အရေးကြီးရင် Profile > Support မှာ ဆက်သွယ်နိုင်ပါတယ်)');
      return;
    }

    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const reply = clean(await askAI(text, user));
      await safeSend(chatId, id, reply || 'ခဏနေမှ ပြန်မေးကြည့်ပေးပါဗျ 🙏');
    } catch (err) {
      await giveBack(user); // a failed question does not use up the user's quota
      // no key available (limits reached / outage): tell the user once, then stay silent. Nothing is queued.
      if (err instanceof NoKeyError && noticeOnce(id, 'down')) {
        await safeSend(chatId, id, 'လက်ရှိ AI အသုံးပြုမှု များနေပါတယ်ဗျ။ ခဏနေမှ ပြန်မေးကြည့်ပေးပါ 🙏');
      } else if (!(err instanceof NoKeyError)) console.error('[ai] chat error:', err.message);
    }
  } catch (err) {
    console.error('[ai] handler error:', err.message);
  } finally {
    busy.delete(id);
    running--;
  }
}
