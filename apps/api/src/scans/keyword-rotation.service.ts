import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Model, Types } from 'mongoose';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from '../brands/schemas/monitored-brand.schema';
import {
  KeywordRotation,
  KeywordRotationDocument,
  KeywordRotationSlot,
} from './schemas/keyword-rotation.schema';
import {
  QUEUE_KEYWORD_ROTATION,
  KeywordRotationJobData,
  keywordRotationJobId,
} from '../queues/queue.constants';
import { ScanQueueService } from '../queues/scan-queue.service';
import { safeJobError } from '../queues/queue.utils';
import { GitHubService } from '../github/github.service';

export interface KeywordRotationSlotInput {
  brandId: string;
  keyword: string;
  durationMs: number;
  /** Which GitHub search kind(s) this keyword's turn should run - see KeywordRotationSlot.searchScope. Defaults to 'both' when omitted. */
  searchScope?: 'both' | 'repositories' | 'code';
  /** Resume this keyword's queries from its own discovery cursor instead of restarting at page 1 every turn - see KeywordRotationSlot.continueDiscovery. Defaults to true when omitted. */
  continueDiscovery?: boolean;
}

const VALID_SEARCH_SCOPES = ['both', 'repositories', 'code'] as const;

export interface StartKeywordRotationOptions {
  /** User-built, user-ordered queue - exactly the sequence to run, in that order. Can mix keywords from several different companies. */
  slots: KeywordRotationSlotInput[];
  dateFilterMode?: 'any' | 'dated';
  createdFrom?: string;
  createdTo?: string;
  pushedFrom?: string;
  pushedTo?: string;
}

const MIN_SLOT_DURATION_MS = 1_000;
const MAX_SLOT_DURATION_MS = 24 * 60 * 60_000;

/**
 * Explicit shape for getStatus/start/stop's return value - without this,
 * spreading a Mongoose lean() result produces an inferred type complex
 * enough that TS refuses to serialize it (TS7056) wherever these methods'
 * return type flows through (ScansService, ScansController).
 */
export interface KeywordRotationStatus {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  triggeredBy: Types.ObjectId;
  enabled: boolean;
  slots: KeywordRotationSlot[];
  currentIndex: number;
  currentScanJobId?: Types.ObjectId;
  currentBrandId?: Types.ObjectId;
  currentKeyword?: string;
  slotStartedAt?: Date;
  slotEndsAt?: Date;
  pendingAdvanceToken?: string;
  dateFilterMode: 'any' | 'dated';
  createdFrom?: Date;
  createdTo?: Date;
  pushedFrom?: Date;
  pushedTo?: Date;
  cyclesCompleted: number;
  lastError: string;
  /** Time left in the current slot, ms - undefined when disabled or no slot is active. */
  remainingMs?: number;
  /** How many times advance() has extended the current slot because the keyword was still paused for GitHub quota instead of actually working - see KeywordRotation.currentSlotExtensions. */
  currentSlotExtensions: number;
  /** True right now if the current keyword's scan is sitting paused for GitHub quota (rate limit or workspace daily budget) rather than making progress - surfaced so "why is this slot taking so long" has a real answer instead of looking stuck. */
  waitingOnQuota: boolean;
}

/**
 * Sequential, workspace-wide alternative to the per-keyword watch toggle:
 * cycles a single shared queue of keywords (potentially spanning several
 * companies) through ONE "slot" at a time, so whichever keyword is running
 * gets the workspace's whole GitHub-token rate-limit budget instead of
 * splitting it N ways across N concurrently "watched" keywords - see
 * KeywordRotation for the full rationale. Owns the handoff between keywords
 * (advance); each individual scan is still a normal ScanJob enqueued through
 * ScanQueueService, just tagged rotationManaged so
 * ScanStateService.maybeRestartKeywordWatch knows to leave it alone.
 */
@Injectable()
export class KeywordRotationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeywordRotationService.name);

  // Every place that sets enabled=true (start, resumeSlot) does so
  // immediately before a startSlot() call that either populates a running
  // slot + timer or falls back to enabled=false - so in the single-threaded
  // happy path, "enabled=true" should be impossible without an active
  // currentScanJobId/pendingAdvanceToken. But nothing here guards against
  // two concurrent mutations on the same document (a UI pause/resume racing
  // the delayed advance() timer, or two advance() ticks overlapping):
  // Mongoose only saves each caller's own modified paths, so one save can
  // silently leave `enabled: true` standing while another save's
  // current*-clearing fallback lands right after it - stranding the
  // rotation looking "on" with nothing running and no timer left to ever
  // wake it up again. This watchdog is the safety net: periodically finds
  // any rotation stuck in exactly that state and restarts it. Grace period
  // (see WATCHDOG_STALL_GRACE_MS) keeps it from ever racing a mutation
  // that's merely still mid-flight.
  private static readonly WATCHDOG_INTERVAL_MS = 60_000;
  private static readonly WATCHDOG_STALL_GRACE_MS = 45_000;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectModel(KeywordRotation.name)
    private readonly rotationModel: Model<KeywordRotationDocument>,
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
    @InjectQueue(QUEUE_KEYWORD_ROTATION)
    private readonly rotationQueue: Queue<KeywordRotationJobData>,
    @Inject(forwardRef(() => ScanQueueService))
    private readonly scanQueue: ScanQueueService,
    private readonly github: GitHubService,
  ) {}

  onModuleInit() {
    this.watchdogTimer = setInterval(() => {
      void this.recoverStalledRotations().catch((err) => {
        this.logger.warn(
          `Keyword-rotation watchdog pass failed: ${safeJobError(err)}`,
        );
      });
    }, KeywordRotationService.WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
  }

  /**
   * Finds every rotation claiming enabled=true with no scan running and no
   * handoff timer pending - a state that should be unreachable but isn't,
   * for the concurrency reasons explained on WATCHDOG_INTERVAL_MS above -
   * and restarts each one from its current index (startSlot skips forward
   * over anything paused, same as a normal handoff). Best-effort per
   * rotation: one failing to recover (e.g. its workspace/brand got deleted)
   * must not stop the rest from being checked.
   */
  private async recoverStalledRotations(): Promise<void> {
    const cutoff = new Date(
      Date.now() - KeywordRotationService.WATCHDOG_STALL_GRACE_MS,
    );
    const stalled = await this.rotationModel
      .find({
        enabled: true,
        currentScanJobId: { $exists: false },
        pendingAdvanceToken: { $exists: false },
        updatedAt: { $lt: cutoff },
      })
      .exec();
    for (const doc of stalled) {
      const workspaceId = String(doc.workspaceId);
      this.logger.warn(
        `Keyword rotation for workspace ${workspaceId} was enabled with no active slot or pending handoff - restarting from index ${doc.currentIndex}`,
      );
      try {
        await this.startSlot(doc, workspaceId, doc.currentIndex);
      } catch (err) {
        this.logger.warn(
          `Keyword-rotation watchdog recovery failed for workspace ${workspaceId}: ${safeJobError(err)}`,
        );
      }
    }
  }

  async getStatus(workspaceId: string): Promise<KeywordRotationStatus | null> {
    const doc = await this.rotationModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .lean()
      .exec();
    if (!doc) return null;
    const pausedUntil =
      doc.enabled && doc.currentScanJobId
        ? await this.github.getScanPausedUntil(String(doc.currentScanJobId))
        : null;
    return {
      ...doc,
      remainingMs:
        doc.enabled && doc.slotEndsAt
          ? Math.max(0, new Date(doc.slotEndsAt).getTime() - Date.now())
          : undefined,
      waitingOnQuota: Boolean(pausedUntil),
    };
  }

  /**
   * Shared by start() and addSlots(): validates duration bounds and that
   * every keyword genuinely belongs to the company it's tagged with, in one
   * batched lookup regardless of how many distinct companies the queue
   * spans. Throws BadRequestException on the first problem found.
   */
  private async validateSlots(
    workspaceId: string,
    rawSlots: KeywordRotationSlotInput[],
  ): Promise<KeywordRotationSlot[]> {
    const parsed = rawSlots.map((s) => {
      const durationMs = Math.trunc(s.durationMs);
      if (
        !Number.isFinite(durationMs) ||
        durationMs < MIN_SLOT_DURATION_MS ||
        durationMs > MAX_SLOT_DURATION_MS
      ) {
        throw new BadRequestException(
          `Each keyword's duration must be between ${MIN_SLOT_DURATION_MS / 1000}s and 24h`,
        );
      }
      const keyword = s.keyword?.trim();
      if (!keyword) {
        throw new BadRequestException('Every queued slot needs a keyword');
      }
      if (!Types.ObjectId.isValid(s.brandId)) {
        throw new BadRequestException(
          `Invalid company for keyword "${keyword}"`,
        );
      }
      if (s.searchScope && !VALID_SEARCH_SCOPES.includes(s.searchScope)) {
        throw new BadRequestException(
          `Invalid searchScope for keyword "${keyword}" - must be 'both', 'repositories', or 'code'`,
        );
      }
      return {
        brandId: s.brandId,
        keyword,
        durationMs,
        searchScope: s.searchScope ?? 'both',
        continueDiscovery: s.continueDiscovery !== false,
      };
    });

    // One lookup for every distinct company referenced in the queue, not one
    // per slot - a queue mixing several companies must still validate in a
    // single round trip.
    const brandIds = [...new Set(parsed.map((s) => s.brandId))];
    const brands = await this.brandModel
      .find({
        _id: { $in: brandIds },
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .select('keywords')
      .lean()
      .exec();
    const brandById = new Map(
      brands.map((b) => [
        String(b._id),
        new Set((b.keywords || []).map((k) => k.toLowerCase())),
      ]),
    );
    for (const slot of parsed) {
      const keywordSet = brandById.get(slot.brandId);
      if (!keywordSet) {
        throw new BadRequestException(
          `Company not found for keyword "${slot.keyword}"`,
        );
      }
      if (!keywordSet.has(slot.keyword.toLowerCase())) {
        throw new BadRequestException(
          `"${slot.keyword}" isn't one of that company's own keywords`,
        );
      }
    }

    return parsed.map((s) => ({
      brandId: new Types.ObjectId(s.brandId),
      keyword: s.keyword,
      durationMs: s.durationMs,
      searchScope: s.searchScope,
      continueDiscovery: s.continueDiscovery,
    }));
  }

  async start(
    workspaceId: string,
    userId: string,
    options: StartKeywordRotationOptions,
  ): Promise<KeywordRotationStatus | null> {
    if (!options.slots || options.slots.length === 0) {
      throw new BadRequestException(
        'Queue at least one keyword (with a duration) before starting the scheduler',
      );
    }
    const slots = await this.validateSlots(workspaceId, options.slots);

    const dateFilterMode = options.dateFilterMode === 'dated' ? 'dated' : 'any';
    const doc =
      (await this.rotationModel
        .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
        .exec()) ||
      new this.rotationModel({ workspaceId: new Types.ObjectId(workspaceId) });

    // Starting fresh always wins over whatever was running before - cancel
    // any in-flight slot scan and clear its pending advance timer first,
    // same as stop(), so a restart with a different queue can never leave an
    // orphaned scan or timer from the old configuration behind.
    await this.cancelCurrentSlot(doc);

    doc.triggeredBy = new Types.ObjectId(userId);
    doc.enabled = true;
    doc.slots = slots;
    doc.currentIndex = 0;
    doc.cyclesCompleted = 0;
    doc.dateFilterMode = dateFilterMode;
    doc.createdFrom = options.createdFrom
      ? new Date(options.createdFrom)
      : undefined;
    doc.createdTo = options.createdTo ? new Date(options.createdTo) : undefined;
    doc.pushedFrom = options.pushedFrom
      ? new Date(options.pushedFrom)
      : undefined;
    doc.pushedTo = options.pushedTo ? new Date(options.pushedTo) : undefined;
    doc.lastError = '';
    await doc.save();

    await this.startSlot(doc, workspaceId, 0);
    return this.getStatus(workspaceId);
  }

  async stop(workspaceId: string): Promise<KeywordRotationStatus | null> {
    const doc = await this.rotationModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!doc || !doc.enabled) return this.getStatus(workspaceId);

    await this.cancelCurrentSlot(doc);
    doc.enabled = false;
    doc.currentScanJobId = undefined;
    doc.currentBrandId = undefined;
    doc.currentKeyword = undefined;
    doc.slotStartedAt = undefined;
    doc.slotEndsAt = undefined;
    doc.pendingAdvanceToken = undefined;
    doc.currentSlotExtensions = 0;
    await doc.save();
    return this.getStatus(workspaceId);
  }

  /**
   * Appends one or more keywords to the END of an ALREADY-RUNNING queue,
   * without touching whichever keyword currently holds the turn or anything
   * else already queued - they'll simply come up in their turn once the
   * cycle reaches them. Duplicates of a company+keyword pair already in the
   * queue are silently dropped rather than erroring (a double-click, or
   * re-adding something already there, shouldn't fail the whole request).
   * Requires the scheduler to already be running - starting it fresh is
   * start()'s job, not this one.
   */
  async addSlots(
    workspaceId: string,
    newSlots: KeywordRotationSlotInput[],
  ): Promise<KeywordRotationStatus | null> {
    if (!newSlots || newSlots.length === 0) {
      throw new BadRequestException('Add at least one keyword');
    }
    const doc = await this.rotationModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!doc || !doc.enabled) {
      throw new BadRequestException(
        "The scheduler isn't running - use Start instead",
      );
    }
    const validated = await this.validateSlots(workspaceId, newSlots);
    const existing = new Set(
      doc.slots.map((s) => `${s.brandId} ${s.keyword.toLowerCase()}`),
    );
    const toAdd = validated.filter(
      (s) => !existing.has(`${s.brandId} ${s.keyword.toLowerCase()}`),
    );
    if (toAdd.length > 0) {
      doc.slots.push(...toAdd);
      doc.markModified('slots');
      await doc.save();
    }
    return this.getStatus(workspaceId);
  }

  /** Finds the slot matching this exact company+keyword - throws if the rotation doesn't exist or has no such slot queued. */
  private async getDocAndSlotIndex(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<{ doc: KeywordRotationDocument; index: number }> {
    const doc = await this.rotationModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    if (!doc) throw new NotFoundException('No scheduler queue found');
    const index = doc.slots.findIndex(
      (s) =>
        String(s.brandId) === brandId &&
        s.keyword.toLowerCase() === keyword.toLowerCase(),
    );
    if (index === -1) {
      throw new NotFoundException(`"${keyword}" isn't in the current queue`);
    }
    return { doc, index };
  }

  /**
   * Pauses exactly ONE queued keyword, leaving every other slot (and the
   * rotation as a whole) untouched. If this happens to be the slot currently
   * holding the turn, its scan is cancelled - the same progress-preserving
   * cancel every handoff already does, via each query's own DiscoveryCursor
   * - and control hands off immediately to the next non-paused slot, rather
   * than waiting out its remaining duration. If every slot ends up paused,
   * the rotation disables itself (same as running out of runnable keywords
   * any other way) instead of spinning with nothing to do.
   */
  async pauseSlot(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<KeywordRotationStatus | null> {
    const { doc, index } = await this.getDocAndSlotIndex(
      workspaceId,
      brandId,
      keyword,
    );
    doc.slots[index].paused = true;
    doc.markModified('slots');
    if (doc.enabled && doc.currentIndex === index) {
      await this.cancelCurrentSlot(doc);
      await this.startSlot(doc, workspaceId, (index + 1) % doc.slots.length);
    } else {
      await doc.save();
    }
    return this.getStatus(workspaceId);
  }

  /**
   * Resumes exactly ONE previously paused keyword. It rejoins the normal
   * cycle on its next turn if the rotation is still running; if the whole
   * rotation had stopped (e.g. every other slot was paused too, or the user
   * hit Stop), resuming restarts it starting from this slot right away -
   * "resume" should mean the keyword picks back up, not "wait for a Start
   * click that has no obvious button to go with it."
   */
  async resumeSlot(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<KeywordRotationStatus | null> {
    const { doc, index } = await this.getDocAndSlotIndex(
      workspaceId,
      brandId,
      keyword,
    );
    doc.slots[index].paused = false;
    doc.markModified('slots');
    // Also restarts when the rotation claims enabled=true but has no scan
    // running and no handoff timer pending - see recoverStalledRotations
    // above for how it can end up stuck there. Without this, resuming a
    // keyword on an already-stalled rotation would just flip its paused
    // flag and go back to doing nothing, leaving the user's most obvious
    // recovery action look like it silently failed.
    const isStalled =
      doc.enabled && !doc.currentScanJobId && !doc.pendingAdvanceToken;
    if (!doc.enabled || isStalled) {
      doc.enabled = true;
      await doc.save();
      await this.startSlot(doc, workspaceId, index);
    } else {
      await doc.save();
    }
    return this.getStatus(workspaceId);
  }

  /**
   * Changes which GitHub search kind(s) ONE queued keyword runs -
   * 'repositories' only, 'code' only, or 'both'. If this happens to be the
   * slot currently holding the turn, its scan is cancelled and immediately
   * restarted with the new choice (the same progress-preserving cancel
   * every handoff already uses - repos already discovered stay recorded),
   * so the change takes effect right away instead of waiting for this
   * keyword's next turn. Every other slot is untouched.
   */
  async setSlotSearchScope(
    workspaceId: string,
    brandId: string,
    keyword: string,
    searchScope: 'both' | 'repositories' | 'code',
  ): Promise<KeywordRotationStatus | null> {
    if (!VALID_SEARCH_SCOPES.includes(searchScope)) {
      throw new BadRequestException(
        "searchScope must be 'both', 'repositories', or 'code'",
      );
    }
    const { doc, index } = await this.getDocAndSlotIndex(
      workspaceId,
      brandId,
      keyword,
    );
    doc.slots[index].searchScope = searchScope;
    doc.markModified('slots');
    if (doc.enabled && doc.currentIndex === index) {
      await this.cancelCurrentSlot(doc);
      await this.startSlot(doc, workspaceId, index);
    } else {
      await doc.save();
    }
    return this.getStatus(workspaceId);
  }

  /**
   * Changes whether ONE queued keyword resumes its queries from its own
   * discovery cursor (true, the default) or restarts every query at page 1
   * on every turn (false). If this happens to be the slot currently
   * holding the turn, its scan is cancelled and immediately restarted with
   * the new choice, same as setSlotSearchScope. Every other slot is
   * untouched.
   */
  async setSlotContinueDiscovery(
    workspaceId: string,
    brandId: string,
    keyword: string,
    continueDiscovery: boolean,
  ): Promise<KeywordRotationStatus | null> {
    const { doc, index } = await this.getDocAndSlotIndex(
      workspaceId,
      brandId,
      keyword,
    );
    doc.slots[index].continueDiscovery = continueDiscovery;
    doc.markModified('slots');
    if (doc.enabled && doc.currentIndex === index) {
      await this.cancelCurrentSlot(doc);
      await this.startSlot(doc, workspaceId, index);
    } else {
      await doc.save();
    }
    return this.getStatus(workspaceId);
  }

  /**
   * Permanently removes exactly ONE keyword from the queue - from any
   * state (running, stopped, individually paused). If it's the slot
   * currently holding the turn, its scan is cancelled first (the same
   * progress-preserving cancel every handoff already uses - repos already
   * discovered stay recorded) and the next non-paused slot picks up
   * immediately, same as pauseSlot's handoff. If it was the last slot left,
   * the rotation disables itself rather than spinning on an empty queue.
   */
  async removeSlot(
    workspaceId: string,
    brandId: string,
    keyword: string,
  ): Promise<KeywordRotationStatus | null> {
    const { doc, index } = await this.getDocAndSlotIndex(
      workspaceId,
      brandId,
      keyword,
    );
    const wasCurrent = doc.enabled && doc.currentIndex === index;
    if (wasCurrent) {
      await this.cancelCurrentSlot(doc);
    }

    doc.slots.splice(index, 1);
    doc.markModified('slots');

    if (doc.slots.length === 0) {
      doc.enabled = false;
      doc.currentScanJobId = undefined;
      doc.currentBrandId = undefined;
      doc.currentKeyword = undefined;
      doc.slotStartedAt = undefined;
      doc.slotEndsAt = undefined;
      doc.pendingAdvanceToken = undefined;
      await doc.save();
      return this.getStatus(workspaceId);
    }

    if (wasCurrent) {
      // Everything after the removed slot shifted left by one, so the slot
      // that used to follow it now sits at this same numeric index.
      await this.startSlot(doc, workspaceId, index % doc.slots.length);
    } else {
      // Removing something earlier than the running slot shifts its index
      // left by one too - keep currentIndex pointing at the same logical
      // slot it did before.
      if (doc.enabled && index < doc.currentIndex) {
        doc.currentIndex -= 1;
      }
      await doc.save();
    }
    return this.getStatus(workspaceId);
  }

  /**
   * Hands off from whichever keyword currently holds the slot to the next
   * one in the queue (wrapping around). Called by the delayed "slot elapsed"
   * job, which must match the doc's current pendingAdvanceToken - a stale
   * timer from a slot that already ended early is a no-op instead of firing
   * a spurious extra handoff.
   */
  async advance(
    workspaceId: string,
    opts: { token?: string } = {},
  ): Promise<void> {
    const doc = await this.rotationModel
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .exec();
    // Rotation was stopped (or never existed) after this timer was
    // scheduled - a normal race, not an error.
    if (!doc || !doc.enabled) return;
    if (opts.token && doc.pendingAdvanceToken !== opts.token) {
      this.logger.debug(
        `Stale keyword-rotation advance for workspace ${workspaceId} ignored (token mismatch)`,
      );
      return;
    }

    if (await this.tryExtendSlotForQuotaPause(doc, workspaceId)) return;

    await this.cancelCurrentSlot(doc);

    const nextIndex = (doc.currentIndex + 1) % doc.slots.length;
    if (nextIndex === 0) doc.cyclesCompleted += 1;
    await this.startSlot(doc, workspaceId, nextIndex);
  }

  // A keyword whose turn starts right after another one exhausted the
  // shared GitHub quota (rate limit or workspace daily budget) could
  // otherwise spend its ENTIRE slot paused, doing zero real work, before
  // being cut off on schedule anyway - see KeywordRotation.
  // currentSlotExtensions' doc comment. These bound how much benefit of
  // the doubt one blocked keyword gets before advance() gives up waiting
  // and hands off normally, so a long-lived block (e.g. the daily budget
  // not resetting for hours) can't monopolize the whole shared queue.
  private static readonly MAX_SLOT_QUOTA_EXTENSIONS = 3;
  // Extra time granted AFTER the pause clears, so the keyword gets to
  // actually do something once unblocked rather than resuming for a
  // moment and immediately hitting the next advance() tick.
  private static readonly QUOTA_EXTENSION_BUFFER_MS = 30_000;
  // Never extend a single slot to wait out a pause longer than this, even
  // if the pause itself (e.g. a daily budget reset) is much further out -
  // better to hand off and let this keyword catch up on its next normal
  // turn than block every other queued keyword for hours.
  private static readonly MAX_SINGLE_QUOTA_EXTENSION_MS = 10 * 60_000;

  /**
   * Extends the CURRENT slot instead of handing off, if (and only if) the
   * keyword's scan is still sitting paused for GitHub quota right now.
   * Returns true when it extended (caller must not proceed with the normal
   * handoff this tick), false when there's nothing to wait for or the
   * extension budget for this slot is already used up (proceed normally).
   */
  private async tryExtendSlotForQuotaPause(
    doc: KeywordRotationDocument,
    workspaceId: string,
  ): Promise<boolean> {
    if (!doc.currentScanJobId) return false;
    if (
      doc.currentSlotExtensions >=
      KeywordRotationService.MAX_SLOT_QUOTA_EXTENSIONS
    ) {
      return false;
    }
    const pausedUntil = await this.github.getScanPausedUntil(
      String(doc.currentScanJobId),
    );
    if (!pausedUntil) return false;

    const waitMs = Math.max(0, pausedUntil - Date.now());
    const extension = Math.min(
      waitMs + KeywordRotationService.QUOTA_EXTENSION_BUFFER_MS,
      KeywordRotationService.MAX_SINGLE_QUOTA_EXTENSION_MS,
    );

    const token = randomUUID();
    doc.slotEndsAt = new Date(Date.now() + extension);
    doc.pendingAdvanceToken = token;
    doc.currentSlotExtensions += 1;
    await doc.save();

    await this.rotationQueue.add(
      'advance',
      { workspaceId, token },
      {
        delay: extension,
        jobId: keywordRotationJobId(workspaceId, token),
        removeOnComplete: true,
        removeOnFail: true,
      },
    );

    this.logger.log(
      `Keyword rotation: "${doc.currentKeyword}" is still paused for GitHub quota (until ${new Date(pausedUntil).toISOString()}) - extending its slot by ${extension}ms instead of handing off having made no progress (extension ${doc.currentSlotExtensions}/${KeywordRotationService.MAX_SLOT_QUOTA_EXTENSIONS} for workspace ${workspaceId})`,
    );
    return true;
  }

  /** Best-effort cancel of whatever scan/timer the doc currently thinks is active - safe to call even if there is none (cancelScan on an already-terminal job is a no-op). */
  private async cancelCurrentSlot(doc: KeywordRotationDocument) {
    if (doc.currentScanJobId) {
      try {
        await this.scanQueue.cancelScan(
          String(doc.workspaceId),
          String(doc.currentScanJobId),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to cancel prior rotation scan ${doc.currentScanJobId} for workspace ${doc.workspaceId}: ${safeJobError(err)}`,
        );
      }
    }
    if (doc.pendingAdvanceToken) {
      const jobId = keywordRotationJobId(
        String(doc.workspaceId),
        doc.pendingAdvanceToken,
      );
      await this.rotationQueue.remove(jobId).catch(() => undefined);
    }
  }

  /**
   * Starts the slot at `fromIndex`, skipping forward (bounded to one full
   * lap) over any keyword that's individually paused (see pauseSlot) or
   * whose independent watch-toggle scan is already active - that's a real
   * conflict (enqueueManualScan's duplicate-active check), not a rotation
   * bug, so the rotation just tries the next keyword instead of stalling
   * entirely. If every keyword is paused and/or conflicts, the rotation
   * disables itself with lastError set rather than spinning forever.
   */
  private async startSlot(
    doc: KeywordRotationDocument,
    workspaceId: string,
    fromIndex: number,
  ): Promise<void> {
    const total = doc.slots.length;
    for (let attempt = 0; attempt < total; attempt++) {
      const index = (fromIndex + attempt) % total;
      const {
        brandId,
        keyword,
        durationMs: slotMs,
        paused,
        searchScope,
        continueDiscovery,
      } = doc.slots[index];
      if (paused) continue;
      try {
        const job = await this.scanQueue.enqueueManualScan(
          workspaceId,
          String(doc.triggeredBy),
          {
            brandId: String(brandId),
            keyword,
            discoveryOnly: true,
            continueDiscovery: continueDiscovery !== false,
            rotationManaged: true,
            searchScope: searchScope ?? 'both',
            ...(doc.dateFilterMode === 'dated' && doc.createdFrom
              ? { createdFrom: doc.createdFrom.toISOString().slice(0, 10) }
              : {}),
            ...(doc.dateFilterMode === 'dated' && doc.createdTo
              ? { createdTo: doc.createdTo.toISOString().slice(0, 10) }
              : {}),
            ...(doc.dateFilterMode === 'dated' && doc.pushedFrom
              ? { pushedFrom: doc.pushedFrom.toISOString().slice(0, 10) }
              : {}),
            ...(doc.dateFilterMode === 'dated' && doc.pushedTo
              ? { pushedTo: doc.pushedTo.toISOString().slice(0, 10) }
              : {}),
            ...(doc.dateFilterMode === 'dated' &&
            (doc.createdFrom || doc.createdTo || doc.pushedFrom || doc.pushedTo)
              ? { dateFilterMode: 'or' as const }
              : {}),
          },
        );

        const token = randomUUID();
        doc.currentIndex = index;
        doc.currentBrandId = brandId;
        doc.currentKeyword = keyword;
        doc.currentScanJobId = new Types.ObjectId(job._id);
        doc.slotStartedAt = new Date();
        doc.slotEndsAt = new Date(Date.now() + slotMs);
        doc.pendingAdvanceToken = token;
        // Fresh turn, fresh extension budget - see tryExtendSlotForQuotaPause.
        doc.currentSlotExtensions = 0;
        doc.lastError = '';
        await doc.save();

        await this.rotationQueue.add(
          'advance',
          { workspaceId, token },
          {
            delay: slotMs,
            jobId: keywordRotationJobId(workspaceId, token),
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
        return;
      } catch (err) {
        if (err instanceof ConflictException) {
          this.logger.warn(
            `Keyword rotation skipped "${keyword}" (brand ${brandId}) for workspace ${workspaceId} - already independently active`,
          );
          continue;
        }
        this.logger.warn(
          `Keyword rotation failed to start "${keyword}" (brand ${brandId}) for workspace ${workspaceId}: ${safeJobError(err)}`,
        );
        continue;
      }
    }

    // Every keyword is paused, conflicted, or failed - nothing to run right now.
    doc.enabled = false;
    doc.currentScanJobId = undefined;
    doc.currentBrandId = undefined;
    doc.currentKeyword = undefined;
    doc.slotStartedAt = undefined;
    doc.slotEndsAt = undefined;
    doc.pendingAdvanceToken = undefined;
    doc.lastError = doc.slots.every((s) => s.paused)
      ? 'Every keyword in the queue is paused - resume at least one to keep the scheduler running.'
      : "Couldn't start any keyword - each one already has an independently active watch-toggle scan running. Stop those first, or remove them from the queue.";
    await doc.save();
  }
}
