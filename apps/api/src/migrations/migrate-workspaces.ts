/**
 * Safe multi-tenancy migration.
 *
 * Assigns existing tenant-less records to a shared "Default Workspace",
 * adds all existing users as members (owner role — this is a legacy,
 * pre-multi-tenancy compatibility path; the running app itself only ever
 * creates one owner per workspace and has no invite/multi-member flow),
 * and updates unique indexes to be workspace-scoped.
 *
 * Usage:
 *   cd apps/api && npm run migrate:workspaces
 *
 * Idempotent: safe to re-run. Does not delete data.
 */
import mongoose, { Types } from 'mongoose';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../.env') });
dotenv.config({ path: resolve(__dirname, '../../../../.env') });

async function dropIndexSafe(
  collection: {
    dropIndex: (name: string) => Promise<unknown>;
    collectionName: string;
  },
  indexName: string,
) {
  try {
    await collection.dropIndex(indexName);
    console.log(`Dropped index ${collection.collectionName}.${indexName}`);
  } catch (error) {
    const message = (error as Error).message || '';
    if (!/index not found|ns not found/i.test(message)) {
      console.warn(
        `Could not drop ${collection.collectionName}.${indexName}: ${message}`,
      );
    }
  }
}

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  console.log('Connected. Starting workspace migration...');

  const workspaces = db.collection('workspaces');
  const members = db.collection('workspacemembers');
  const users = db.collection('users');

  let defaultWs = await workspaces.findOne({ slug: 'default-workspace' });
  const allUsers = await users.find({}).sort({ createdAt: 1 }).toArray();

  if (!defaultWs) {
    const ownerId =
      allUsers[0]?._id || new Types.ObjectId('000000000000000000000001');
    const insert = await workspaces.insertOne({
      name: 'Default Workspace',
      slug: 'default-workspace',
      ownerId,
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    defaultWs = await workspaces.findOne({ _id: insert.insertedId });
    console.log(`Created Default Workspace: ${String(insert.insertedId)}`);
  } else {
    console.log(`Using existing Default Workspace: ${String(defaultWs._id)}`);
  }

  const workspaceId = defaultWs!._id;

  for (let i = 0; i < allUsers.length; i += 1) {
    const user = allUsers[i];
    const role = 'owner';
    await members.updateOne(
      { workspaceId, email: user.email },
      {
        $setOnInsert: {
          workspaceId,
          userId: user._id,
          email: user.email,
          role,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  console.log(`Ensured membership for ${allUsers.length} users`);

  const tenantCollections = [
    'monitoredbrands',
    'repositories',
    'findings',
    'detections',
    'scanjobs',
    'alerts',
    'applicationsettings',
  ];

  for (const name of tenantCollections) {
    const col = db.collection(name);
    const result = await col.updateMany(
      { workspaceId: { $exists: false } },
      { $set: { workspaceId } },
    );
    console.log(
      `${name}: assigned workspaceId to ${result.modifiedCount} documents`,
    );
  }

  // Drop legacy global unique indexes that conflict with multi-tenancy
  await dropIndexSafe(db.collection('monitoredbrands'), 'name_1');
  await dropIndexSafe(db.collection('repositories'), 'githubId_1');
  await dropIndexSafe(db.collection('repositories'), 'fullName_1');
  await dropIndexSafe(
    db.collection('findings'),
    'repositoryId_1_fingerprint_1',
  );
  await dropIndexSafe(db.collection('applicationsettings'), 'key_1');

  // Ensure compound indexes
  await db
    .collection('monitoredbrands')
    .createIndex({ workspaceId: 1, name: 1 }, { unique: true });
  await db
    .collection('repositories')
    .createIndex({ workspaceId: 1, githubId: 1 }, { unique: true });
  await db
    .collection('repositories')
    .createIndex({ workspaceId: 1, fullName: 1 }, { unique: true });
  await db
    .collection('findings')
    .createIndex(
      { workspaceId: 1, repositoryId: 1, fingerprint: 1 },
      { unique: true },
    );
  await db
    .collection('applicationsettings')
    .createIndex({ workspaceId: 1, key: 1 }, { unique: true });
  await db
    .collection('workspacemembers')
    .createIndex({ workspaceId: 1, email: 1 }, { unique: true });

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
