/**
 * Backfills Repository.origin for documents that were written before this
 * field was reliably stamped on every upsert.
 *
 * Root cause: RepositoryAnalysisProcessor's upsertRepository calls only
 * write origin when the caller's `internalAudit` flag is explicitly
 * true/false - two call sites (the normal keyword/GitHub-search discovery
 * path in GitHubSearchProcessor, and the analyze_pending replay path in
 * ScanOrchestratorProcessor) never included it at all, so `internalAudit`
 * arrived as `undefined` and origin was silently never written on insert.
 * Since these upserts use `findOneAndUpdate({...}, update, { upsert: true })`
 * without `setDefaultsOnInsert`, Mongoose's schema-level `default: 'external'`
 * never kicked in either - the field was just missing entirely. Every repo
 * missing `origin` is invisible on the Repositories page, which filters on
 * `origin: 'external'` exactly (an exact-match filter does not match a
 * missing field).
 *
 * This migration determines the correct value per-repo using the same
 * signal the code itself should have used at write time: the internalAudit
 * flag on whichever ScanJob most recently touched the repo
 * (Repository.lastScanJobId). A repo with no traceable scan job (or a
 * missing/deleted one) defaults to 'external' - internal audit is the rare,
 * narrow path, and any repo that ever reached analyze_pending's pending
 * queue is guaranteed external (internal audit runs full analysis
 * immediately and never defers via pendingAnalysis).
 *
 * Usage:
 *   cd apps/api && npm run migrate:repository-origin
 *
 * Idempotent: only ever touches documents where origin is currently
 * missing. Safe to re-run - a second run finds nothing left to do.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../../../../.env') });

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  console.log('Connected. Starting repository origin backfill...');

  const scanJobs = db.collection('scanjobs');
  const repositories = db.collection('repositories');

  const missingBefore = await repositories.countDocuments({
    origin: { $exists: false },
  });
  console.log(`Repositories missing origin before backfill: ${missingBefore}`);

  const internalAuditScanJobIds = await scanJobs
    .find({ internalAudit: true }, { projection: { _id: 1 } })
    .map((d) => d._id)
    .toArray();
  console.log(
    `Found ${internalAuditScanJobIds.length} internal-audit scan jobs`,
  );

  const internalResult = await repositories.updateMany(
    {
      origin: { $exists: false },
      lastScanJobId: { $in: internalAuditScanJobIds },
    },
    { $set: { origin: 'internal' } },
  );
  console.log(
    `repositories: backfilled origin='internal' for ${internalResult.modifiedCount} documents`,
  );

  const externalResult = await repositories.updateMany(
    { origin: { $exists: false } },
    { $set: { origin: 'external' } },
  );
  console.log(
    `repositories: backfilled origin='external' for ${externalResult.modifiedCount} documents`,
  );

  const missingAfter = await repositories.countDocuments({
    origin: { $exists: false },
  });
  console.log(`Repositories missing origin after backfill: ${missingAfter}`);

  console.log('Migration completed successfully.');
  await mongoose.disconnect();
}

migrate().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
