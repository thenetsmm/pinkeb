import { config } from '../config.js';
import { User } from '../models/index.js';
import { tg, webAppUrl } from '../lib/telegram.js';

export const job = { running: false, total: 0, sent: 0, failed: 0, startedAt: null, finishedAt: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE = 25; // messages per second (Telegram allows ~30)

export const recipientCount = () => User.countDocuments({ banned: false });

/** Sends a message to every user in the background, 25 per second. */
export async function startBroadcast({ text, imageUrl, buttonText, appUrl }) {
  if (job.running) throw new Error('A broadcast is already running');
  Object.assign(job, { running: true, total: await recipientCount(), sent: 0, failed: 0, startedAt: new Date(), finishedAt: null });

  const url = appUrl || webAppUrl();
  let reply_markup;
  if (buttonText && url) {
    reply_markup = { inline_keyboard: [[/t\.me\//i.test(url) ? { text: buttonText, url } : { text: buttonText, web_app: { url } }]] };
  }

  (async () => {
    try {
      const cursor = User.find({ banned: false }).select('telegramId').lean().cursor();
      let batch = [];
      const flush = async () => {
        const part = batch;
        batch = [];
        await Promise.all(
          part.map(async (id) => {
            const r = imageUrl
              ? await tg('sendPhoto', { chat_id: id, photo: imageUrl, caption: text.slice(0, 1000), parse_mode: 'HTML', reply_markup })
              : await tg('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup });
            if (r?.ok) job.sent += 1;
            else job.failed += 1;
          })
        );
        await sleep(1000);
      };
      for await (const u of cursor) {
        batch.push(u.telegramId);
        if (batch.length >= RATE) await flush();
      }
      if (batch.length) await flush();
    } catch (e) {
      console.error('[broadcast]', e);
    } finally {
      job.running = false;
      job.finishedAt = new Date();
    }
  })();
  return job;
}
