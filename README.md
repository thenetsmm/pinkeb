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

## Promo codes / Piggy Bank / Channel
- Promo code ဖန်တီးရန် (admin ဖြစ်ရမယ်၊ ADMIN_IDS): bot ထဲမှာ `/promo SHADOW20 20 100 24` = code, +20 pts, လူ ၁၀၀, ၂၄ နာရီ (ကြော်ငြာမကြည့်ရ)။ ကြော်ငြာကြည့်ခိုင်းချင်ရင် နောက်ဆုံးမှာ `ad` ထည့်ပါ။
- Withdraw ပယ်ချရင် အကြောင်းပြချက်နဲ့: `/reject <withdrawalId> KPay နံပါတ် မှားနေပါတယ်`
- Piggy Bank timer ကို server မှာ သိမ်းတယ် (၁၀ မိနစ်၊ +2 / ကြော်ငြာနဲ့ +15)။
- Channel bonus: `CHANNEL_USERNAME` ထည့်ပြီး bot ကို channel admin လုပ်ထားရင် join မှန်/မမှန် စစ်ပါတယ်။
- ပင်မ Watch Ads: တစ်ရက် ၅ ကြိမ် (MAIN_AD_DAILY_LIMIT)၊ ကြော်ငြာတစ်ခုနဲ့တစ်ခုကြား ၅ မိနစ် (MAIN_AD_COOLDOWN_MINUTES)။
- Watch-5 Daily Task (ကြော်ငြာ ၅ ပုဒ်က pts 0၊ ၅/၅ ပြည့်မှ Claim +125) က Daily Task card ကနေ ကြည့်တဲ့ ကြော်ငြာကိုပဲ ရေတွက်ပါတယ် (ပင်မ Watch Ads နဲ့ သီးသန့်)။

## Admin API (`x-admin-key: ADMIN_API_KEY`)
`GET /api/admin/stats` · `GET /api/admin/withdrawals?status=pending` · `POST /api/admin/withdrawals/:id/approve|reject` · `GET|POST /api/admin/offers` · `POST /api/admin/users/:telegramId/ban`

## Local run
`cp .env.example .env` → ဖြည့် → `npm install && npm run dev`  (Telegram မပါဘဲစမ်းချင်ရင် `DEV_AUTH=true` + header `x-dev-user: 111`)

## Admin Panel (Mini App ထဲမှာ)
- Render env: `ADMIN_IDS=7072739469` (သင့် Telegram ID) နဲ့ `ADMIN_PIN=<ဂဏန်း ၆လုံး>` ထည့်ပါ။ Redeploy လုပ်ပါ။
- App > Profile ထဲမှာ admin ID နဲ့ဝင်ရင်သာ "⚙️ Admin Panel" ပေါ်ပါမယ်။ PIN ထည့်မှ ဖွင့်ပါမယ် (ကြိမ် ၅ ခါမှားရင် ၁၀ မိနစ်ပိတ်)။
- `/api/admin/*` အားလုံးက Telegram identity (ADMIN_IDS) + `x-admin-pin` နှစ်ခုလုံးစစ်ပါတယ်။
- Modules: Overview, Withdrawals (Approve / Reject & Refund / Reject & Ban), Users, Settings (MongoDB ထဲသိမ်း၊ redeploy မလို), Tasks, Promo + Broadcast, Anti-Fraud + Maintenance/Pause switches။
- Reject & Ban က points ပြန်မထည့်ပါ။ Channel task verify အတွက် bot ကို channel admin လုပ်ထားရမယ်။

## AI Support Bot
- Bot ထဲ ပုံမှန်စာရိုက်ရင် AI က ဖြေပါတယ်။ Admin Panel > 🤖 AI မှာ Gemini/Groq key တွေ ထည့်/ပြင်/ဖျက်၊ daily limit သတ်မှတ်ပါ။
- Key တွေကို AES-256-GCM နဲ့ encrypt လုပ်ပြီး DB ထဲသိမ်းတယ် (`AI_KEY_SECRET` ကို Render env မှာထည့်ပါ)။ Frontend ဆီ ဘယ်တော့မှ မပို့ပါ။
- Key တစ်ခု 429/quota ပြည့်ရင် အလိုအလျောက် ပိတ်ထားပြီး နောက် key နဲ့ တစ်ခါတည်း ဆက်ဖြေပါတယ်။ ပြန်ပွင့်ချိန်ရောက်ရင် ကိုယ့်ဘာသာ ပြန်သုံးပါတယ်။
- Spam ကာကွယ်: user တစ်ယောက် ၃ စက္ကန့်တစ်ခါ၊ စာလုံးရေကန့်သတ်၊ မေးနေဆဲဆိုရင် ထပ်မခံ၊ ၂ မိနစ်ကျော်စာဟောင်းကို မဖြေ၊ Limit/outage မှာ ၁ ခါပဲ အကြောင်းကြား၊ စာတွေ queue မလုပ်။ Bot ကို block ထားသူကို မှတ်ထားပြီး broadcast ကျော်ပါတယ်။
