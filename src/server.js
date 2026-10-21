import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { config } from './config.js';
import { ApiError } from './middleware/auth.js';
import apiRoutes from './routes/api.js';
import adminRoutes from './routes/admin.js';
import botRoutes, { setupBot } from './routes/bot.js';
import { Offer } from './models/index.js';

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // allow Telegram/Vercel frontend(s) listed in FRONTEND_URL; allow tools without Origin (curl, server-to-server)
      if (!origin || config.frontendUrls.length === 0 || config.frontendUrls.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'x-dev-user', 'x-dev-start'],
  })
);
app.use(express.json({ limit: '20kb' }));

app.get('/', (req, res) => res.json({ name: 'PinkEarn API', ok: true }));
app.get('/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));

app.use('/api/bot', botRoutes);
app.use('/api/admin', rateLimit({ windowMs: 60_000, limit: 60 }), adminRoutes); // before /api (which requires Telegram auth)
app.use('/api', rateLimit({ windowMs: 60_000, limit: 150, standardHeaders: true, legacyHeaders: false }), apiRoutes);

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, message: err.message });
  console.error('[error]', err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong' });
});

async function seedOffers() {
  if (await Offer.estimatedDocumentCount()) return;
  await Offer.insertMany([
    { key: 'short-video', title: 'Short video ad', reward: 10, seconds: 15, dailyLimit: 5, sort: 1 },
    { key: 'sponsored', title: 'Sponsored ad', reward: 20, seconds: 20, dailyLimit: 3, sort: 2 },
  ]);
  console.log('[seed] default offers created');
}

async function main() {
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(config.mongoUri);
  console.log('[db] connected');
  await seedOffers();
  app.listen(config.port, () => console.log(`[server] listening on :${config.port}`));
  setupBot().catch((e) => console.warn('[bot] setup error', e.message));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
