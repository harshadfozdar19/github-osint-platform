import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KeywordRotationDocument = HydratedDocument<KeywordRotation>;

/**
 * One keyword's own turn in the rotation, with its own hh:mm:ss duration and
 * its own company - user-built and user-ordered, not derived from any one
 * brand's keyword list. Slots can (and typically do) mix keywords from
 * several different companies in one shared, workspace-wide queue.
 */
export interface KeywordRotationSlot {
  brandId: Types.ObjectId;
  keyword: string;
  durationMs: number;
  /**
   * True once the user pauses THIS one keyword specifically (see
   * KeywordRotationService.pauseSlot/resumeSlot) - skipped when the rotation
   * picks its next turn, without affecting any other queued keyword. If this
   * slot happens to be the one currently running when paused, its scan is
   * cancelled (progress preserved via its own DiscoveryCursor) and control
   * hands off to the next non-paused slot immediately, same as a normal
   * handoff. Resuming just clears this flag - it rejoins the cycle on its
   * next turn (or restarts the rotation right away if nothing else was
   * running).
   */
  paused?: boolean;
  /**
   * Which GitHub search kind(s) this keyword's own turn should run -
   * 'both' (default), 'repositories' only, or 'code' only. Lets the user
   * deliberately choose instead of always running both - e.g. code
   * search's much tighter 10/min ceiling can leave a keyword stuck waiting
   * on it for its whole turn even while repo search (30/min) still has
   * headroom; picking 'repositories' skips that wait entirely. See the
   * per-row search-scope control in KeywordScheduleQueue and
   * KeywordRotationService.setSlotSearchScope.
   */
  searchScope?: 'both' | 'repositories' | 'code';
  /**
   * True (default) resumes this keyword's own queries from where its
   * discovery of them last left off (its durable DiscoveryCursor), instead
   * of every turn restarting each one at page 1 and re-fetching the same
   * top (most-recently-updated) results. False deliberately starts fresh
   * every turn - e.g. to keep re-checking whatever's newest right now
   * rather than working deeper into older results. See the per-row
   * "Start from beginning" / "Resume from last" control in
   * KeywordScheduleQueue and KeywordRotationService.setSlotContinueDiscovery.
   */
  continueDiscovery?: boolean;
}

/**
 * One workspace's sequential keyword scheduler - the alternative to the
 * per-keyword "watch" toggle (KeywordScanner.tsx), which runs every enabled
 * keyword concurrently and splits the workspace's single GitHub token quota
 * N ways. This instead runs exactly ONE keyword's discovery scan at a time,
 * so it gets the token's FULL rate-limit budget for its own turn, then hands
 * off to the next keyword in `slots` (wrapping back to the start once every
 * keyword has had a turn - see KeywordRotationService.advance). Each keyword
 * gets its own user-chosen duration and can belong to any company - the
 * queue is workspace-wide, not scoped to whichever company happens to be
 * selected in the UI right now, so switching companies while browsing never
 * loses what's already queued. Each keyword resumes from its own durable
 * DiscoveryCursor rather than re-walking results it already covered on a
 * previous turn, so repeated cycles keep making forward progress toward
 * "every matching repo" instead of restarting at page 1 every time.
 *
 * One document per WORKSPACE (unique on workspaceId) - there is exactly one
 * shared queue/sequence per workspace, not one per company, since the whole
 * point is fair, exclusive use of the one shared GitHub token across
 * everything you've queued regardless of which company it belongs to.
 */
@Schema({ timestamps: true, collection: 'keyword_rotations' })
export class KeywordRotation {
  @Prop({
    type: Types.ObjectId,
    ref: 'Workspace',
    required: true,
  })
  workspaceId!: Types.ObjectId;

  /** User who started the rotation - carried forward as `triggeredBy` on every scan it enqueues, including auto-advanced ones the user never directly clicked "start" on. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  triggeredBy!: Types.ObjectId;

  @Prop({ required: true, default: false })
  enabled!: boolean;

  /**
   * The user-built queue this rotation cycles through, in order, each with
   * its own company and duration - snapshotted at start(), so editing a
   * brand's keyword list (or re-queuing) later doesn't reshuffle a rotation
   * already in progress. Not derived from any brand.keywords order; this is
   * exactly the sequence the user assembled via the scheduler queue UI,
   * potentially spanning several companies.
   */
  @Prop({
    type: [
      {
        brandId: Types.ObjectId,
        keyword: String,
        durationMs: Number,
        paused: Boolean,
        searchScope: {
          type: String,
          enum: ['both', 'repositories', 'code'],
          default: 'both',
        },
        continueDiscovery: { type: Boolean, default: true },
      },
    ],
    required: true,
    default: [],
  })
  slots!: KeywordRotationSlot[];

  /** Index into `slots` of the keyword currently holding the slot (or that most recently held it, once stopped). */
  @Prop({ required: true, default: 0 })
  currentIndex!: number;

  @Prop({ type: Types.ObjectId, ref: 'ScanJob' })
  currentScanJobId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'MonitoredBrand' })
  currentBrandId?: Types.ObjectId;

  @Prop({ type: String })
  currentKeyword?: string;

  @Prop({ type: Date })
  slotStartedAt?: Date;

  @Prop({ type: Date })
  slotEndsAt?: Date;

  /**
   * How many times advance() has extended the CURRENT slot instead of
   * handing off, because the keyword's scan was still sitting paused for
   * GitHub quota (rate limit or workspace daily budget) rather than
   * actually working - see KeywordRotationService.advance and
   * MAX_SLOT_QUOTA_EXTENSIONS. Without this, a keyword whose turn happened
   * to start right after another keyword exhausted the shared quota could
   * spend its ENTIRE slot paused and accomplish nothing before being cut
   * off on schedule anyway. Reset to 0 every time a new slot actually
   * starts (startSlot) - it only tracks extensions within the current
   * keyword's current turn, capped so one persistently-blocked keyword
   * can't monopolize the whole queue indefinitely (e.g. if the daily
   * budget won't reset for hours).
   */
  @Prop({ required: true, default: 0 })
  currentSlotExtensions!: number;

  /**
   * Disambiguates the currently pending "slot elapsed" delayed job from any
   * earlier one for this same workspace - see KeywordRotationJobData.token.
   * The processor compares this against the firing job's own token and
   * no-ops if they don't match (a stale timer for a slot that already ended
   * early).
   */
  @Prop({ type: String })
  pendingAdvanceToken?: string;

  /** Same date-filter shape as the per-keyword toggle's "Filter by dates"/"Any date" choice (KeywordScanner.tsx) - applied uniformly to every keyword in this rotation, regardless of company. */
  @Prop({
    type: String,
    enum: ['any', 'dated'],
    required: true,
    default: 'any',
  })
  dateFilterMode!: 'any' | 'dated';

  @Prop({ type: Date })
  createdFrom?: Date;

  @Prop({ type: Date })
  createdTo?: Date;

  @Prop({ type: Date })
  pushedFrom?: Date;

  @Prop({ type: Date })
  pushedTo?: Date;

  /** How many full cycles (every keyword having had at least one turn) this rotation has completed - purely informational, shown in the UI so a stalled-looking rotation can be told apart from one that's steadily progressing. */
  @Prop({ required: true, default: 0 })
  cyclesCompleted!: number;

  /** Set when start()/advance() couldn't get any keyword running (e.g. every one already has an independent watch-toggle scan active) - surfaced in the UI instead of the rotation just silently doing nothing. */
  @Prop({ type: String, default: '' })
  lastError!: string;
}

export const KeywordRotationSchema =
  SchemaFactory.createForClass(KeywordRotation);
KeywordRotationSchema.index({ workspaceId: 1 }, { unique: true });
