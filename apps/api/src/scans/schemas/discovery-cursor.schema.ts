import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DiscoveryCursorDocument = HydratedDocument<DiscoveryCursor>;

/**
 * Durable, cross-scan pagination bookmark for one exact GitHub search query -
 * lets a scan opted into "continue discovery" pick up at the next page
 * instead of every scan re-fetching the same slice of results (GitHub search
 * is always sorted `updated:desc` here, so page 1 comes back nearly
 * identical run to run unless something changed). Keyed on the literal query
 * text, not a brand id or query-family label, since the query text already
 * fully encodes brand name/aliases/keywords/date-range and is the thing
 * actually being paginated - changing any of those naturally invalidates an
 * old cursor by no longer matching it, with no explicit migration needed.
 * Lives outside ScanJob.checkpoint on purpose: that checkpoint is scoped to
 * (and deleted with) one scan job, while this needs to outlive it.
 */
@Schema({ timestamps: true, collection: 'discovery_search_cursors' })
export class DiscoveryCursor {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  })
  workspaceId!: Types.ObjectId;

  @Prop({ type: String, enum: ['repositories', 'code'], required: true })
  kind!: 'repositories' | 'code';

  /** sha256 of `${kind}:${query}` - stable, fixed-length, safe as an index key regardless of query length/characters. */
  @Prop({ required: true })
  queryHash!: string;

  /** Raw query text, kept only for operator visibility/debugging - never used for lookups. */
  @Prop({ required: true })
  query!: string;

  /** Last GitHub search results page successfully processed for this exact query. */
  @Prop({ required: true, default: 0 })
  lastPage!: number;

  /**
   * True once GitHub returned a short/final page (or the query hit GitHub's
   * own 1000-result cap) for this query - there's nothing further back to
   * fetch, so the next scan should restart at page 1 rather than requesting
   * an empty page forever. Since sort is updated:desc, page 1 will simply
   * pick up whatever changed since last time.
   */
  @Prop({ required: true, default: false })
  exhausted!: boolean;
}

export const DiscoveryCursorSchema =
  SchemaFactory.createForClass(DiscoveryCursor);
DiscoveryCursorSchema.index(
  { workspaceId: 1, kind: 1, queryHash: 1 },
  { unique: true },
);
