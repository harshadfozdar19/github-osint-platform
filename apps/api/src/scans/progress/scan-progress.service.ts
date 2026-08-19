import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { filter, finalize, map, merge, takeUntil } from 'rxjs';
import { ScanJobStatus, TERMINAL_SCAN_STATUSES } from '../../common/enums';

const TERMINAL_JOB_STATUSES = TERMINAL_SCAN_STATUSES;
import { safeJobError } from '../../queues/queue.utils';
import { ScanJob, ScanJobDocument } from '../schemas/scan-job.schema';
import {
  ScanProgressCounts,
  ScanProgressEmitInput,
  ScanProgressEvent,
  ScanProgressEventType,
  ScanProgressPhase,
  computeProgressPercent,
  emptyCounts,
  isTerminalProgressType,
  scanProgressChannel,
} from './scan-progress.types';

type ThrottleState = {
  lastEmitAt: number;
  pending?: ScanProgressEmitInput;
  timer?: ReturnType<typeof setTimeout>;
};

@Injectable()
export class ScanProgressService implements OnModuleDestroy {
  private readonly logger = new Logger(ScanProgressService.name);
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly throttleMs: number;
  private readonly throttle = new Map<string, ThrottleState>();
  /** Local fan-out for same-process subscribers (plus Redis for multi-instance). */
  private readonly local = new Map<string, Subject<ScanProgressEvent>>();
  /** Dedupe Redis echo of events this process just published. */
  private readonly publishedSeq = new Map<string, number>();

  constructor(
    @InjectModel(ScanJob.name)
    private readonly scanModel: Model<ScanJobDocument>,
    config: ConfigService,
  ) {
    this.throttleMs = Number(config.get('SCAN_PROGRESS_THROTTLE_MS') || 500);
    this.publisher = this.createRedis(config);
    this.subscriber = this.createRedis(config);
    this.subscriber.on('message', (channel, message) => {
      this.onRedisMessage(channel, message);
    });
  }

  async onModuleDestroy() {
    for (const state of this.throttle.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.throttle.clear();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }

  /**
   * Emit a progress event: assign seq, persist latest, publish over Redis.
   * Non-terminal events are throttled per scan.
   */
  async emit(input: ScanProgressEmitInput): Promise<ScanProgressEvent | null> {
    const terminal =
      input.terminal === true || isTerminalProgressType(input.type);
    const force = input.force === true || terminal;

    if (!force && this.shouldThrottle(input.scanJobId)) {
      this.queueThrottled(input);
      return null;
    }

    return this.emitNow(input, terminal);
  }

  /** Latest persisted progress for polling / page refresh. */
  async getLatest(
    workspaceId: string,
    scanJobId: string,
    afterSeq = 0,
  ): Promise<ScanProgressEvent | null> {
    const job = await this.loadOwned(workspaceId, scanJobId);
    const event = this.fromJob(job);
    if (!event) return null;
    if (afterSeq > 0 && event.seq <= afterSeq) return null;
    return event;
  }

  /**
   * SSE stream: snapshot (if newer than afterSeq) then live events with seq > afterSeq.
   * Heartbeats keep the connection alive across proxies.
   */
  stream(
    workspaceId: string,
    scanJobId: string,
    afterSeq = 0,
  ): Observable<{ data: string; id?: string; type?: string }> {
    const subject = this.ensureLocal(scanJobId);
    const channel = scanProgressChannel(scanJobId);
    void this.subscriber.subscribe(channel).catch((err: unknown) => {
      this.logger.warn(`Redis subscribe failed: ${safeJobError(err)}`);
    });

    // Fires the moment we know the scan is done, so the whole merged stream
    // (including heartbeats) ends immediately instead of lingering until an
    // external timeout kills the connection. Reconnecting with afterSeq
    // already pinned to the terminal event's own seq (the normal case right
    // after a client receives it) would otherwise never see a "newer" event
    // and never learn the scan is over — this checks the job's persisted
    // status directly instead of relying on a fresh event flowing through.
    const stop$ = new Subject<void>();
    const stop = () => {
      stop$.next();
      stop$.complete();
    };

    const snapshot$ = new Observable<{
      data: string;
      id?: string;
      type?: string;
    }>((subscriber) => {
      void this.loadOwned(workspaceId, scanJobId)
        .then((job) => {
          const latest = this.fromJob(job);
          if (latest && latest.seq > afterSeq) {
            subscriber.next({
              data: JSON.stringify(latest),
              id: String(latest.seq),
              type: latest.type,
            });
          }
          subscriber.complete();
          if (TERMINAL_JOB_STATUSES.includes(job.status)) {
            stop();
          }
        })
        .catch((err: unknown) => subscriber.error(err));
    });

    const live$ = subject.pipe(
      filter((event) => event.workspaceId === workspaceId),
      filter((event) => event.seq > afterSeq),
      map((event) => {
        if (event.terminal) stop();
        return {
          data: JSON.stringify(event),
          id: String(event.seq),
          type: event.type,
        };
      }),
    );

    const heartbeat$ = new Observable<{
      data: string;
      id?: string;
      type?: string;
    }>((subscriber) => {
      const timer = setInterval(() => {
        subscriber.next({
          data: JSON.stringify({
            ping: true,
            timestamp: new Date().toISOString(),
          }),
          type: 'heartbeat',
        });
      }, 15_000);
      return () => clearInterval(timer);
    });

    return merge(snapshot$, live$, heartbeat$).pipe(
      takeUntil(stop$),
      finalize(() => {
        // Keep Redis subscription; cheap and allows multi-client. Unsubscribe when idle.
        const sub = this.local.get(scanJobId);
        if (sub && !sub.observed) {
          void this.subscriber.unsubscribe(channel).catch(() => undefined);
        }
      }),
    );
  }

  /** Build a progress event from current Mongo counters (no publish). */
  buildFromJobDoc(
    job: ScanJobDocument | (ScanJob & { _id: Types.ObjectId }),
    overrides: Partial<ScanProgressEmitInput> = {},
  ): ScanProgressEmitInput {
    const workspaceId = String(job.workspaceId);
    const scanJobId = String(job._id);
    const counts = this.countsFromJob(job);
    // A caller's overrides.status is usually just "what phase am I in" and
    // is safe to trust (e.g. RUNNING while a search job is mid-flight) -
    // except when the freshly-read job doc is ALREADY terminal. That
    // happens when a scan gets cancelled (e.g. the sequential scheduler's
    // keyword handoff, ScanStateService.finalize) while some other worker
    // that hadn't yet noticed the cancellation is still wrapping up and
    // calls emitFromScanId with a hardcoded status: RUNNING. Without this,
    // that straggler's event would broadcast "running" over the live
    // progress stream for an already-cancelled/completed scan, making the
    // UI appear to keep going well past when it actually stopped. A
    // terminal DB status can never legitimately un-terminalize, so it
    // always wins over a non-terminal override.
    const status = TERMINAL_JOB_STATUSES.includes(job.status)
      ? job.status
      : overrides.status || job.status;
    const phase =
      overrides.phase ||
      this.phaseFromStatus(status, counts, job.awaitingSearch || 0);
    const type = overrides.type || this.typeFromStatus(status, overrides.type);
    return {
      workspaceId,
      scanJobId,
      type,
      phase,
      status,
      message: overrides.message || job.message || 'Scan progress',
      counts: { ...counts, ...overrides.counts },
      terminal: overrides.terminal,
      force: overrides.force,
      percent: overrides.percent,
    };
  }

  async emitFromScanId(
    scanJobId: string,
    overrides: Partial<ScanProgressEmitInput>,
  ): Promise<ScanProgressEvent | null> {
    const job = await this.scanModel.findById(scanJobId).exec();
    if (!job) return null;
    return this.emit(this.buildFromJobDoc(job, overrides));
  }

  private async emitNow(
    input: ScanProgressEmitInput,
    terminal: boolean,
  ): Promise<ScanProgressEvent> {
    const state = this.throttle.get(input.scanJobId);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
      state.pending = undefined;
    }

    const safeMessage = this.sanitizeMessage(input.message);
    const counts: ScanProgressCounts = {
      ...emptyCounts(),
      ...input.counts,
    };
    const phase = input.phase;
    const status = input.status;
    const percent =
      input.percent ?? computeProgressPercent({ status, phase, counts });

    const updated = await this.scanModel
      .findOneAndUpdate(
        {
          _id: input.scanJobId,
          workspaceId: new Types.ObjectId(input.workspaceId),
        },
        {
          $inc: { progressSeq: 1 },
          $set: {
            progressPhase: phase,
            progressPercent: percent,
            progressEventType: input.type,
            progressMessage: safeMessage,
            progressUpdatedAt: new Date(),
            progressTerminal: terminal,
            progressCounts: counts,
          },
        },
        { new: true },
      )
      .lean()
      .exec();

    if (!updated) {
      throw new NotFoundException('Scan job not found');
    }

    const event: ScanProgressEvent = {
      scanJobId: input.scanJobId,
      workspaceId: input.workspaceId,
      seq: updated.progressSeq || 1,
      type: input.type,
      phase,
      status,
      percent: updated.progressPercent ?? percent,
      message: safeMessage,
      timestamp: new Date(
        updated.progressUpdatedAt || Date.now(),
      ).toISOString(),
      counts,
      terminal,
    };

    this.throttle.set(input.scanJobId, { lastEmitAt: Date.now() });
    await this.publish(event);
    return event;
  }

  private async publish(event: ScanProgressEvent) {
    this.publishedSeq.set(event.scanJobId, event.seq);
    const channel = scanProgressChannel(event.scanJobId);
    try {
      await this.publisher.publish(channel, JSON.stringify(event));
    } catch (err) {
      this.logger.warn(`Redis publish failed: ${safeJobError(err)}`);
    }
    // Fan-out locally so same-process SSE works even if Redis is down.
    this.ensureLocal(event.scanJobId).next(event);
  }

  private onRedisMessage(channel: string, message: string) {
    if (!channel.startsWith('scan:progress:')) return;
    try {
      const event = JSON.parse(message) as ScanProgressEvent;
      if (!event?.scanJobId || typeof event.seq !== 'number') return;
      if (this.publishedSeq.get(event.scanJobId) === event.seq) {
        return;
      }
      const subject = this.local.get(event.scanJobId);
      if (!subject) return;
      subject.next(event);
    } catch {
      // ignore malformed
    }
  }

  private shouldThrottle(scanJobId: string): boolean {
    const state = this.throttle.get(scanJobId);
    if (!state) return false;
    return Date.now() - state.lastEmitAt < this.throttleMs;
  }

  private queueThrottled(input: ScanProgressEmitInput) {
    let state = this.throttle.get(input.scanJobId);
    if (!state) {
      state = { lastEmitAt: 0 };
      this.throttle.set(input.scanJobId, state);
    }
    state.pending = input;
    if (state.timer) return;
    const wait = Math.max(0, this.throttleMs - (Date.now() - state.lastEmitAt));
    state.timer = setTimeout(() => {
      const pending = state?.pending;
      if (state) {
        state.timer = undefined;
        state.pending = undefined;
      }
      if (pending) {
        void this.emitNow(
          pending,
          pending.terminal === true || isTerminalProgressType(pending.type),
        ).catch((err: unknown) =>
          this.logger.warn(`Throttled emit failed: ${safeJobError(err)}`),
        );
      }
    }, wait);
  }

  private ensureLocal(scanJobId: string): Subject<ScanProgressEvent> {
    let subject = this.local.get(scanJobId);
    if (!subject) {
      subject = new Subject<ScanProgressEvent>();
      this.local.set(scanJobId, subject);
    }
    return subject;
  }

  private async loadOwned(workspaceId: string, scanJobId: string) {
    if (!Types.ObjectId.isValid(scanJobId)) {
      throw new NotFoundException('Scan job not found');
    }
    const job = await this.scanModel
      .findOne({
        _id: scanJobId,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .lean()
      .exec();
    if (!job) throw new NotFoundException('Scan job not found');
    return job;
  }

  private fromJob(
    job: ScanJob & {
      _id: Types.ObjectId;
      progressSeq?: number;
      progressPhase?: string;
      progressPercent?: number;
      progressEventType?: string;
      progressMessage?: string;
      progressUpdatedAt?: Date;
      progressTerminal?: boolean;
      progressCounts?: ScanProgressCounts;
    },
  ): ScanProgressEvent | null {
    if (!job.progressSeq) {
      // Synthesize from job status for older scans / first load.
      const counts = this.countsFromJob(job);
      const phase = this.phaseFromStatus(
        job.status,
        counts,
        job.awaitingSearch || 0,
      );
      const type = this.typeFromStatus(job.status);
      const terminal = isTerminalProgressType(type);
      return {
        scanJobId: String(job._id),
        workspaceId: String(job.workspaceId),
        seq: 0,
        type,
        phase,
        status: job.status,
        percent: computeProgressPercent({
          status: job.status,
          phase,
          counts,
        }),
        message: this.sanitizeMessage(
          job.message || job.error || 'Scan status',
        ),
        timestamp: new Date(
          job.progressUpdatedAt ||
            job.finishedAt ||
            job.startedAt ||
            Date.now(),
        ).toISOString(),
        counts,
        terminal,
      };
    }

    const counts = job.progressCounts || this.countsFromJob(job);
    return {
      scanJobId: String(job._id),
      workspaceId: String(job.workspaceId),
      seq: job.progressSeq,
      type: (job.progressEventType ||
        this.typeFromStatus(job.status)) as ScanProgressEventType,
      phase: (job.progressPhase ||
        ScanProgressPhase.QUEUED) as ScanProgressPhase,
      status: job.status,
      percent: job.progressPercent ?? 0,
      message: this.sanitizeMessage(
        job.progressMessage || job.message || 'Scan progress',
      ),
      timestamp: new Date(job.progressUpdatedAt || Date.now()).toISOString(),
      counts,
      terminal: Boolean(job.progressTerminal),
    };
  }

  private countsFromJob(job: {
    reposDiscovered?: number;
    reposProcessed?: number;
    reposFailed?: number;
    reposTotal?: number;
    reposFound?: number;
    reposAnalyzed?: number;
    reposSkipped?: number;
    reposRescanned?: number;
    reposResumed?: number;
    reposPendingAnalysis?: number;
    findingsCreated?: number;
    findingsUpdated?: number;
    findingsNew?: number;
    findingsUnchanged?: number;
    findingsReopened?: number;
    findingsResolved?: number;
    findingsHighRisk?: number;
    queriesUsed?: string[];
    awaitingSearch?: number;
  }): ScanProgressCounts {
    const queriesTotal = job.queriesUsed?.length || 0;
    const awaiting = job.awaitingSearch || 0;
    return {
      reposDiscovered: job.reposDiscovered || job.reposFound || 0,
      reposProcessed: job.reposProcessed || job.reposAnalyzed || 0,
      reposFailed: job.reposFailed || 0,
      reposTotal: job.reposTotal || job.reposDiscovered || job.reposFound || 0,
      findingsCreated: job.findingsCreated || 0,
      findingsUpdated: job.findingsUpdated || 0,
      queriesTotal,
      queriesCompleted: Math.max(0, queriesTotal - awaiting),
      reposSkipped: job.reposSkipped || 0,
      reposRescanned: job.reposRescanned || 0,
      reposResumed: job.reposResumed || 0,
      reposPendingAnalysis: job.reposPendingAnalysis || 0,
      findingsNew: job.findingsNew || 0,
      findingsUnchanged: job.findingsUnchanged || 0,
      findingsReopened: job.findingsReopened || 0,
      findingsResolved: job.findingsResolved || 0,
      findingsHighRisk: job.findingsHighRisk || 0,
    };
  }

  private phaseFromStatus(
    status: ScanJobStatus,
    counts: ScanProgressCounts,
    awaitingSearch: number,
  ): ScanProgressPhase {
    if (status === ScanJobStatus.QUEUED) return ScanProgressPhase.QUEUED;
    if (status === ScanJobStatus.CANCELLED) return ScanProgressPhase.CANCELLED;
    if (status === ScanJobStatus.FAILED) return ScanProgressPhase.FAILED;
    if (
      status === ScanJobStatus.COMPLETED ||
      status === ScanJobStatus.PARTIALLY_COMPLETED
    ) {
      return ScanProgressPhase.COMPLETED;
    }
    if (awaitingSearch > 0 || counts.queriesCompleted < counts.queriesTotal) {
      return ScanProgressPhase.SEARCHING;
    }
    if (counts.reposDiscovered > counts.reposProcessed) {
      return ScanProgressPhase.ANALYZING;
    }
    return ScanProgressPhase.FINALIZING;
  }

  private typeFromStatus(
    status: ScanJobStatus,
    fallback?: ScanProgressEventType,
  ): ScanProgressEventType {
    if (fallback) return fallback;
    switch (status) {
      case ScanJobStatus.QUEUED:
        return ScanProgressEventType.QUEUED;
      case ScanJobStatus.RUNNING:
        return ScanProgressEventType.STARTED;
      case ScanJobStatus.COMPLETED:
      case ScanJobStatus.PARTIALLY_COMPLETED:
        return ScanProgressEventType.COMPLETED;
      case ScanJobStatus.FAILED:
        return ScanProgressEventType.FAILED;
      case ScanJobStatus.CANCELLED:
        return ScanProgressEventType.CANCELLED;
      default:
        return ScanProgressEventType.SEARCH_PROGRESS;
    }
  }

  sanitizeMessage(message: string, maxLen = 300): string {
    return safeJobError(message, maxLen);
  }

  private createRedis(config: ConfigService): Redis {
    const url = config.get<string>('REDIS_URL')?.trim();
    if (url) {
      return new Redis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
      });
    }
    return new Redis({
      host: config.get<string>('REDIS_HOST') || 'localhost',
      port: Number(config.get<string>('REDIS_PORT') || 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });
  }
}

/** Test helper: apply afterSeq filtering like reconnect clients. */
export function filterEventsAfterSeq(
  events: ScanProgressEvent[],
  afterSeq: number,
): ScanProgressEvent[] {
  let last = afterSeq;
  const out: ScanProgressEvent[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= last) continue;
    out.push(event);
    last = event.seq;
  }
  return out;
}
