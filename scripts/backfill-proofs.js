// One-off: create Proof rows (+ channel posts) for withdrawals that were paid before the proof system existed.
// Run on Render shell:  node scripts/backfill-proofs.js
import 'dotenv/config';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { Withdrawal } from '../src/models/index.js';
import { publishPayoutProof } from '../src/services/withdrawals.js';

await mongoose.connect(config.mongoUri);
const list = await Withdrawal.find({ status: 'success' }).sort({ resolvedAt: 1 });
for (const w of list) {
  await publishPayoutProof(w);
  await new Promise((r) => setTimeout(r, 3500)); // Telegram channel rate limit
}
console.log(`Backfilled ${list.length} proofs`);
await mongoose.disconnect();
