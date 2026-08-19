import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CodeFingerprintDocument = HydratedDocument<CodeFingerprint>;

/**
 * One row per (reference repo, file) belonging to a brand's OWN codebase -
 * the ground truth that candidate repos found during external-audit
 * discovery get compared against. Never stores raw file content, only
 * hashes: contentHash for verbatim-copy detection, chunkHashes (winnowed
 * k-gram shingles - see code-fingerprint.util.ts) for near-duplicate
 * detection that survives reformatting/renaming/reorganization.
 */
@Schema({ timestamps: true, collection: 'code_fingerprints' })
export class CodeFingerprint {
  @Prop({ type: Types.ObjectId, ref: 'Workspace', required: true, index: true })
  workspaceId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'MonitoredBrand',
    required: true,
    index: true,
  })
  brandId!: Types.ObjectId;

  /** The client's own GitHub account/org that owns this reference repo. */
  @Prop({ required: true })
  sourceOwner!: string;

  @Prop({ required: true })
  sourceRepo!: string;

  /** Repo-relative path, e.g. "src/components/Login.tsx". */
  @Prop({ required: true })
  filePath!: string;

  /** sha256 (normalized line-endings/trailing-whitespace) of the full file content. */
  @Prop({ required: true })
  contentHash!: string;

  /** Winnowed k-gram shingle hashes - near-duplicate signal, indexed for multikey lookup. */
  @Prop({ type: [String], default: [], index: true })
  chunkHashes!: string[];

  @Prop({ required: true })
  fileSizeBytes!: number;

  /** HEAD commit sha of sourceOwner/sourceRepo at ingestion time, so re-ingestion can skip unchanged repos. */
  @Prop({ required: true })
  commitSha!: string;

  @Prop({ type: Date, default: Date.now })
  ingestedAt!: Date;
}

export const CodeFingerprintSchema =
  SchemaFactory.createForClass(CodeFingerprint);
/** One fingerprint row per reference file; re-ingestion upserts by this key. */
CodeFingerprintSchema.index(
  { workspaceId: 1, brandId: 1, sourceOwner: 1, sourceRepo: 1, filePath: 1 },
  { unique: true },
);
/** Exact-copy lookup: does any candidate file's hash match a reference file's hash. */
CodeFingerprintSchema.index({ workspaceId: 1, contentHash: 1 });
/** Near-duplicate lookup: does any candidate chunk hash match a reference chunk hash. */
CodeFingerprintSchema.index({ workspaceId: 1, chunkHashes: 1 });
/** List/status queries for a brand's reference repos. */
CodeFingerprintSchema.index({
  workspaceId: 1,
  brandId: 1,
  sourceOwner: 1,
  sourceRepo: 1,
});
