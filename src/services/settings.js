import { config } from '../config.js';
import { Setting } from '../models/index.js';
import { ApiError } from '../middleware/auth.js';

/**
 * Settings that the admin panel may change at runtime (no redeploy).
 * Values are stored in MongoDB and written onto the shared `config` object, which the rest of the code reads on every request.
 */
const N = (min, max) => ({ t: 'num', min, max });
const SCHEMA = {
  mainAdReward: N(0, 10000),
  mainAdDailyLimit: N(0, 1000),
  mainAdCooldownMinutes: N(0, 1440),
  adsTaskReward: N(0, 100000),
  adsTaskTarget: N(1, 100),
  piggyCycleSeconds: N(10, 86400),
  piggyBase: N(0, 10000),
  piggyBoosted: N(0, 10000),
  referralBonus: N(0, 100000),
  referralActivationAds: N(1, 100),
  commissionRate: N(0, 1),
  minWithdraw: N(1, 10_000_000),
  spinDailyLimit: N(0, 100),
  scratchDailyLimit: N(0, 100),
  gameCooldownMinutes: N(0, 1440),
  spinPaidCost: N(0, 10000),
  mysteryCost: N(0, 10000),
  adRevenueKs: N(0, 100000),
  channelReward: N(0, 10000),
  streakRewards: { t: 'arr', len: 7, min: 0, max: 100000 },
  gameOdds: { t: 'odds' },
  adsgramBlockId: { t: 'str', max: 80 },
  onclickaSpotId: { t: 'str', max: 80 },
  richadsPubId: { t: 'str', max: 20 },
  richadsAppId: { t: 'str', max: 20 },
  richadsZoneId: { t: 'str', max: 80 },
  adsterraLink: { t: 'str', max: 400 },
  partnerLinks: { t: 'links', len: 5 },
  redirectOnLimit: { t: 'bool' },
  aiEnabled: { t: 'bool' },
  aiLimitEnabled: { t: 'bool' },
  aiDailyLimit: N(1, 1000),
  aiMaxInput: N(50, 2000),
  aiGeminiModel: { t: 'str', max: 80 },
  aiGroqModel: { t: 'str', max: 80 },
  aiExtra: { t: 'str', max: 2000 },
  maintenance: { t: 'bool' },
  pauseWithdrawals: { t: 'bool' },
};
const ODDS_LEN = { spin: 6, scratch: 4, mystery: 3 };
const bad = (m) => new ApiError(400, 'invalid_setting', m);

function clean(key, v) {
  const s = SCHEMA[key];
  if (s.t === 'num') {
    const n = Number(v);
    if (!Number.isFinite(n) || n < s.min || n > s.max) throw bad(`${key} must be between ${s.min} and ${s.max}`);
    return n;
  }
  if (s.t === 'bool') return v === true || v === 'true';
  if (s.t === 'str') {
    const t = String(v ?? '').trim();
    if (t.length > s.max) throw bad(`${key} is too long`);
    return t;
  }
  if (s.t === 'arr') {
    if (!Array.isArray(v) || v.length !== s.len) throw bad(`${key} needs ${s.len} numbers`);
    return v.map((x) => {
      const n = Number(x);
      if (!Number.isFinite(n) || n < s.min || n > s.max) throw bad(`${key}: invalid number`);
      return n;
    });
  }
  if (s.t === 'links') {
    if (!Array.isArray(v)) throw bad(`${key} must be a list`);
    const out = Array.from({ length: s.len }, (_, i) => String(v[i] ?? '').trim());
    for (const l of out) if (l && !/^https?:\/\//i.test(l)) throw bad('Links must start with https://');
    return out;
  }
  if (s.t === 'odds') {
    const out = {};
    for (const [g, len] of Object.entries(ODDS_LEN)) {
      const w = v?.[g];
      if (!Array.isArray(w) || w.length !== len) throw bad(`Odds for ${g} need ${len} numbers`);
      const nums = w.map((x) => Number(x));
      if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 10000)) throw bad(`Odds for ${g}: invalid number`);
      if (nums.reduce((a, b) => a + b, 0) <= 0) throw bad(`Odds for ${g}: at least one weight must be above 0`);
      out[g] = nums;
    }
    return out;
  }
  return v;
}

export const editableValues = () => Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, config[k]]));

function apply(values) {
  for (const [k, v] of Object.entries(values || {})) {
    if (!(k in SCHEMA)) continue;
    try {
      config[k] = clean(k, v);
    } catch {
      /* ignore a bad stored value */
    }
  }
}

export async function loadSettings() {
  const doc = await Setting.findOne({ key: 'main' }).lean();
  if (doc) apply(doc.values);
}

export async function saveSettings(patch) {
  const next = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in SCHEMA)) continue; // unknown keys are ignored
    next[k] = clean(k, v);
  }
  if (!Object.keys(next).length) throw bad('Nothing to save');
  const doc = await Setting.findOne({ key: 'main' });
  const values = { ...(doc?.values || {}), ...next };
  await Setting.findOneAndUpdate({ key: 'main' }, { $set: { values } }, { upsert: true });
  apply(next);
  return editableValues();
}
