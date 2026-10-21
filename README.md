# PinkEarn Backend (Node.js + Express + MongoDB)

Render ပေါ်မှာ deploy လုပ်မယ့် Telegram Mini App backend။

## Render deploy
1. ဒီ folder ကို GitHub repo အသစ်တစ်ခုအဖြစ် push လုပ်ပါ။
2. Render → **New → Web Service** → repo ရွေးပါ။ Build: `npm install`, Start: `npm start` (render.yaml ပါပြီးသား)။
3. **Environment** tab ထဲမှာ `.env.example` ထဲက variables တွေ ဖြည့်ပါ (အရေးကြီးတာတွေ Render env ထဲမှာပဲ ထားရပါမယ်)။
   လိုအပ်ဆုံး: `MONGODB_URI`, `BOT_TOKEN`, `BOT_USERNAME`, `FRONTEND_URL` (Vercel URL), `ADMIN_IDS`, `ADMIN_API_KEY`
4. Deploy ပြီးရင် bot webhook ကို server boot မှာ အလိုအလျောက် register လုပ်ပါတယ် (`RENDER_EXTERNAL_URL` သုံးပါတယ်)။
5. MongoDB Atlas မှာ Network Access ကို `0.0.0.0/0` ခွင့်ပြုပါ (Render free IP မတည်ငြိမ်လို့)။

> Render free plan က မသုံးရင် sleep ဝင်ပါတယ်။ ပထမ request နှေးနိုင်ပါတယ် (UptimeRobot နဲ့ `/health` ကို 5 မိနစ်တစ်ခါ ping လုပ်နိုင်ပါတယ်)။

## Telegram setup
- BotFather: bot ဖန်တီး → token ယူ။ `/newapp` (သို့) menu button က `FRONTEND_URL` ကို အလိုအလျောက်သတ်မှတ်ပါတယ်။
- Referral link: `https://t.me/<BOT_USERNAME>?start=invite<telegramId>` → bot က `/start` လက်ခံပြီး invitedBy မှတ်ကာ "Open PinkEarn" button ပို့ပါတယ်။

## AdsGram
1. adsgram.ai မှာ block ဖန်တီး → `ADSGRAM_BLOCK_ID`။
2. Reward URL: `https://<render-url>/api/ads/adsgram-reward?secret=<ADSGRAM_REWARD_SECRET>&userid=[userId]`
3. Production မှာ `REQUIRE_PROVIDER_CONFIRM=true` နဲ့ `ALLOW_DEMO_ADS=false` ထားပါ။ (Block id မထည့်ထားရင် demo countdown ad ပေါ်ပါတယ်။)

## Business logic (server-side ပဲ တွက်ပါတယ်)
- Auth: Telegram `initData` HMAC စစ် (24 နာရီ)။
- Ad: `/ads/start` → session; `/ads/complete` → အနည်းဆုံးကြာချိန် စစ်၊ session တစ်ခု တစ်ကြိမ်ပဲ ပေးချေ၊ daily cap (default 40)။
- Streak: Day1–7 (`STREAK_REWARDS`), တစ်ရက်ကျော်ရင် Day 1 ပြန်စ။ နေ့စဉ် reset = Myanmar time (`TZ_OFFSET_MINUTES`)။
- Referral: ဖိတ်ခံရသူ ad 5 ပုဒ်ကြည့်ရင် inviter +50 (bonus balance)၊ နောက်ပိုင်း ad တိုင်း 10% commission → Profile မှာ **Claim Bonus** နှိပ်မှ balance ထဲဝင်။
- Withdraw: min 500 Ks (1 pt = 1 Ks)၊ pending တစ်ခုပဲ။ Admin (ADMIN_IDS) ဆီ Telegram message + ✅/❌ button ပို့ပါတယ်၊ reject ရင် points ပြန်ထည့်။

## Games (Lucky Spin / Scratch Card / Mystery Box)
- ရလဒ်ကို server က ထုတ်ပါတယ် (client က animation သာ ပြ)။ Spin/Scratch = ad 1 ခုကြည့် → 1 ကြိမ်, တစ်ရက် 3 ကြိမ်, 10 မိနစ် cooldown (server timestamp)။
- Free spin ကုန်ရင် "Spin Again" 15 pts။ Mystery Box = 15 pts (ad မလို)။
- Daily Leaderboard (Top 10) = ယနေ့ ရတဲ့ net points (Myanmar time)။
- Prize table တွေကို `src/services/games.js` မှာ ပြင်နိုင်ပါတယ်။

## Admin API (`x-admin-key: ADMIN_API_KEY`)
`GET /api/admin/stats` · `GET /api/admin/withdrawals?status=pending` · `POST /api/admin/withdrawals/:id/approve|reject` · `GET|POST /api/admin/offers` · `POST /api/admin/users/:telegramId/ban`

## Local run
`cp .env.example .env` → ဖြည့် → `npm install && npm run dev`  (Telegram မပါဘဲစမ်းချင်ရင် `DEV_AUTH=true` + header `x-dev-user: 111`)
