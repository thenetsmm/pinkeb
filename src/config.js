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
  botUsername: (process.env.BOT_USERNAME || 'PinkEarnBot').replace('@', ''),
  supportUsername: (process.env.SUPPORT_USERNAME || 'PinkEarnSupport').replace('@', ''),
  // Secret used to verify that webhook calls really come from Telegram
  webhookSecret:
    process.env.WEBHOOK_SECRET ||
    (botToken ? crypto.createHash('sha256').update('pe:' + botToken).digest('hex').slice(0, 48) : ''),
  adminIds: list(process.env.ADMIN_IDS).map(Number).filter(Boolean),
  adminApiKey: process.env.ADMIN_API_KEY || '',

  // URLs
  frontendUrls: list(process.env.FRONTEND_URL).map(clean),
  publicUrl: clean(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || ''),

  // Business rules
  tzOffsetMinutes: num(process.env.TZ_OFFSET_MINUTES, 390), // Myanmar UTC+6:30
  ptsPerKs: num(process.env.PTS_PER_KS, 1), // 1 pt = 1 Ks
  minWithdraw: num(process.env.MIN_WITHDRAW_KS, 500),
  withdrawMethods: list(process.env.WITHDRAW_METHODS || 'KBZ Pay,Wave Pay'),

  mainAdReward: num(process.env.MAIN_AD_REWARD, 50),
  mainAdSeconds: num(process.env.MAIN_AD_SECONDS, 30),
  dailyAdCap: num(process.env.DAILY_AD_CAP, 40),
  adsTaskTarget: num(process.env.ADS_TASK_TARGET, 5),
  adsTaskReward: num(process.env.ADS_TASK_REWARD, 100),
  inviteTaskReward: num(process.env.INVITE_TASK_REWARD, 200),
  streakRewards: list(process.env.STREAK_REWARDS || '10,15,20,25,30,40,60').map(Number).filter((n) => n > 0),

  referralActivationAds: num(process.env.REFERRAL_ACTIVATION_ADS, 5),
  referralBonus: num(process.env.REFERRAL_BONUS, 50),
  commissionRate: num(process.env.COMMISSION_RATE, 0.1),

  // Ads provider
  adsgramBlockId: process.env.ADSGRAM_BLOCK_ID || '',
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
