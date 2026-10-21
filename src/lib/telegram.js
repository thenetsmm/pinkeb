import { config } from '../config.js';

/** Minimal Telegram Bot API client (no dependency). */
export async function tg(method, body = {}) {
  if (!config.botToken) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) console.warn(`[telegram] ${method} failed:`, json?.description || res.status);
    return json;
  } catch (err) {
    console.warn(`[telegram] ${method} error:`, err.message);
    return null;
  }
}

export const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const sendMessage = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

export const referralLink = (telegramId) => `https://t.me/${config.botUsername}?start=invite${telegramId}`;

export const webAppUrl = () => config.frontendUrls[0] || '';
