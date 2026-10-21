import { User } from '../models/index.js';

const REF_RE = /^invite(\d{1,15})$/;

export function parseReferral(param) {
  const m = REF_RE.exec(param || '');
  return m ? Number(m[1]) : null;
}

/**
 * Finds or creates a user from a Telegram user object.
 * The referral is stored only when the user is created for the first time.
 */
export async function ensureUser(tgUser, startParam = null) {
  let user = await User.findOne({ telegramId: tgUser.id });

  if (!user) {
    let invitedBy = parseReferral(startParam);
    if (invitedBy === tgUser.id) invitedBy = null;
    if (invitedBy && !(await User.exists({ telegramId: invitedBy }))) invitedBy = null;

    try {
      user = await User.create({
        telegramId: tgUser.id,
        firstName: tgUser.first_name || '',
        lastName: tgUser.last_name || '',
        username: tgUser.username || '',
        photoUrl: tgUser.photo_url || '',
        languageCode: tgUser.language_code || '',
        invitedBy,
      });
    } catch (err) {
      if (err.code === 11000) user = await User.findOne({ telegramId: tgUser.id }); // created concurrently
      else throw err;
    }
    return user;
  }

  // keep profile fields fresh
  const patch = {};
  const next = {
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || '',
    username: tgUser.username || '',
  };
  if (tgUser.photo_url) next.photoUrl = tgUser.photo_url;
  for (const [k, v] of Object.entries(next)) if (user[k] !== v) patch[k] = v;
  if (Object.keys(patch).length) {
    await User.updateOne({ _id: user._id }, { $set: patch });
    Object.assign(user, patch);
  }
  return user;
}
