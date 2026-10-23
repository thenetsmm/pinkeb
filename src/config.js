import 'dotenv/config';
import crypto from 'node:crypto';

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const clean = (u) => u.replace(/\/+$/, '');

const botToken = process.env.BOT_TOKEN || '';

export const config = {
  port: num(process.env.PORT, 3000),
  mongoUri: process.env.MONGODB_URI || '',

  // Telegram
  botToken,
  botUsername: (process.env.BOT_USERNAME || 'shaddowearn_bot').replace('@', ''),
  supportUsername: (process.env.SUPPORT_USERNAME || 'PinkEarnSupport').replace('@', ''),
  // Secret used to verify that webhook calls really come from Telegram
  webhookSecret:
    process.env.WEBHOOK_SECRET ||
    (botToken ? crypto.createHash('sha256').update('pe:' + botToken).digest('hex').slice(0, 48) : ''),
  adminIds: list(process.env.ADMIN_IDS || '8970406745').map(Number).filter(Boolean),
  adminApiKey: process.env.ADMIN_API_KEY || '',

  // AI support bot (all of these except aiSecret are editable in Admin > AI)
  aiSecret: process.env.AI_KEY_SECRET || '', // encrypts the API keys stored in MongoDB (AES-256-GCM)
  aiEnabled: bool(process.env.AI_ENABLED, true),
  aiLimitEnabled: true,
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT) || 10, // questions per user per day
  aiMaxInput: 400, // characters accepted per message
  aiGeminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  aiGroqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  aiExtra: '', // extra facts the admin wants the AI to know

  // URLs
  frontendUrls: list(process.env.FRONTEND_URL).map(clean),
  publicUrl: clean(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || ''),

  // Business rules
  tzOffsetMinutes: num(process.env.TZ_OFFSET_MINUTES, 390), // Myanmar UTC+6:30
  ptsPerKs: num(process.env.PTS_PER_KS, 1), // 1 pt = 1 Ks
  minWithdraw: num(process.env.MIN_WITHDRAW_KS, 500),
  withdrawMethods: list(process.env.WITHDRAW_METHODS || 'KBZ Pay,Wave Pay'),

  appName: process.env.APP_NAME || 'ShadowEarn',

  // Ad earns ~45 Ks, so users get 15 pts per ad and the rest is margin for bonuses
  mainAdReward: num(process.env.MAIN_AD_REWARD, 15),
  mainAdSeconds: num(process.env.MAIN_AD_SECONDS, 30),
  dailyAdCap: num(process.env.DAILY_AD_CAP, 40),
  adsTaskTarget: num(process.env.ADS_TASK_TARGET, 5),
  adsTaskReward: num(process.env.ADS_TASK_REWARD, 125), // paid once, when the 5th ad of the Daily Task is done (the 5 ads themselves pay 0)
  mainAdDailyLimit: num(process.env.MAIN_AD_DAILY_LIMIT, 5),
  mainAdCooldownMinutes: num(process.env.MAIN_AD_COOLDOWN_MINUTES, 5),
  inviteTaskReward: num(process.env.INVITE_TASK_REWARD, 50),
  streakRewards: list(process.env.STREAK_REWARDS || '5,5,10,10,15,15,20').map(Number).filter((n) => n > 0),

  // Games
  gameAdSeconds: num(process.env.GAME_AD_SECONDS, 10), // minimum time an ad session must last before a game can be played
  gameCooldownMinutes: num(process.env.GAME_COOLDOWN_MINUTES, 10),
  spinDailyLimit: num(process.env.SPIN_DAILY_LIMIT, 3),
  scratchDailyLimit: num(process.env.SCRATCH_DAILY_LIMIT, 3),
  spinPaidCost: num(process.env.SPIN_PAID_COST, 15), // "Spin Again" after the free spins are used
  mysteryCost: num(process.env.MYSTERY_COST, 15),

  // Admin
  adminPin: process.env.ADMIN_PIN || '', // 6 digits - keep it in the Render env only
  adRevenueKs: num(process.env.AD_REVENUE_KS, 45), // what one ad earns you, for the profit calculator

  // Runtime-editable from the admin panel (saved in MongoDB, see services/settings.js)
  gameOdds: { spin: [45, 25, 8, 2, 0, 20], scratch: [40, 30, 20, 10], mystery: [65, 30, 5] },
  richadsZoneId: '',
  adsterraLink: '',
  partnerLinks: ['', '', '', '', ''],
  redirectOnLimit: true,
  maintenance: false,
  pauseWithdrawals: false,

  // Home extras
  piggyCycleSeconds: num(process.env.PIGGY_CYCLE_SECONDS, 600), // 10 minutes
  piggyBase: num(process.env.PIGGY_BASE_REWARD, 2), // claim without an ad
  piggyBoosted: num(process.env.PIGGY_BOOST_REWARD, 15), // claim after watching an ad
  // Public channel where every PAID withdrawal is posted automatically (masked). Needed for AdsGram 'proof of payouts'. e.g. ShadowEarnPayouts or -100123...
  proofChannel: (process.env.PAYMENT_PROOF_CHANNEL || '').trim(),
  channelUsername: (process.env.CHANNEL_USERNAME || '').replace('@', ''), // e.g. ShadowEarnOfficial (leave empty to hide the banner)
  channelReward: num(process.env.CHANNEL_REWARD, 10),

  referralActivationAds: num(process.env.REFERRAL_ACTIVATION_ADS, 5),
  referralBonus: num(process.env.REFERRAL_BONUS, 50),
  commissionRate: num(process.env.COMMISSION_RATE, 0.1),

  // Ads provider
  adsgramBlockId: process.env.ADSGRAM_BLOCK_ID || '',
  onclickaSpotId: process.env.ONCLICKA_SPOT_ID || '', // OnClickA Telegram video ads (backup network)
  adsgramRewardSecret: process.env.ADSGRAM_REWARD_SECRET || '',
  // When true, the server only pays after AdsGram's server-to-server reward callback arrived.
  requireProviderConfirm: bool(process.env.REQUIRE_PROVIDER_CONFIRM, false),
  // Demo ads (a plain countdown) - set ALLOW_DEMO_ADS=false in production once real ads are live.
  allowDemoAds: bool(process.env.ALLOW_DEMO_ADS, true),

  // Local testing only: accept `x-dev-user: <id>` header instead of Telegram initData
  devAuth: bool(process.env.DEV_AUTH, false),
};

if (config.devAuth && process.env.NODE_ENV === 'production') {
  console.warn('[config] DEV_AUTH is enabled in production! Disable it.');
}
