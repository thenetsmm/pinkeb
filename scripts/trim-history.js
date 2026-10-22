// One-off cleanup: keeps only the newest 10 history rows per user. Run once:  node scripts/trim-history.js
import 'dotenv/config';
import mongoose from 'mongoose';
import { Transaction } from '../src/models/index.js';

await mongoose.connect(process.env.MONGODB_URI);
const users = await Transaction.distinct('userId');
let removed = 0;
for (const id of users) {
  const keep = await Transaction.find({ userId: id }).sort({ createdAt: -1 }).limit(10).select('_id').lean();
  const r = await Transaction.deleteMany({ userId: id, _id: { $nin: keep.map((k) => k._id) } });
  removed += r.deletedCount;
}
console.log(`Trimmed ${removed} old history rows for ${users.length} users`);
await mongoose.disconnect();
