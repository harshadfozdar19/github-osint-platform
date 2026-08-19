import { ScanJobStatus } from '../../common/enums';

/** User-facing progress event types emitted over SSE / poll. */
export enum ScanProgressEventType {
  QUEUED = 'scan.queued',
  STARTED = 'scan.started',
  SEARCH_PROGRESS = 'scan.search_progress',
  REPOSITORIES_DISCOVERED = 'scan.repositories_discovered',
  REPOSITORIES_PROCESSED = 'scan.repositories_processed',
  FINDINGS_CREATED = 'scan.findings_created',
  WARNING = 'scan.warning',
  COMPLETED = 'scan.completed',
  FAILED = 'scan.failed',
  CANCELLED = 'scan.cancelled',
}

export enum ScanProgressPhase {
  QUEUED = 'queued',
  ORCHESTRATING = 'orchestrating',
  SEARCHING = 'searching',
  ANALYZING = 'analyzing',
  FINALIZING = 'finalizing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export interface ScanProgressCounts {
  reposDiscovered: number;
  reposProcessed: number;
  reposFailed: number;
  reposTotal: number;
  findingsCreated: number;
  findingsUpdated: number;
  queriesTotal: number;
  queriesCompleted: number;
  reposSkipped: number;
  reposRescanned: number;
  reposResumed: number;
  /** Repos this scan discovered and saved but deliberately did NOT analyze (discoveryOnly mode) - see Repository.pendingAnalysis. */
  reposPendingAnalysis: number;
  findingsNew: number;
  findingsUnchanged: number;
  findingsReopened: number;
  findingsResolved: number;
  /**
   * Repos processed in this scan whose resulting finding was HIGH or
   * CRITICAL severity - "out of the repos we looked at, how many are
   * actually a real threat" (external scans: impersonators/clones; internal
   * audits: the client's own repos leaking a credential badly enough to
   * matter). Distinct from findingsNew/findingsUpdated, which count
   * findings regardless of severity.
   */
  findingsHighRisk: number;
}

export interface ScanProgressEvent {
  scanJobId: string;
  workspaceId: string;
  /** Monotonic per-scan sequence for reconnect dedupe / ordering */
  seq: number;
  type: ScanProgressEventType;
  phase: ScanProgressPhase;
  status: ScanJobStatus;
  percent: number;
  message: string;
  timestamp: string;
  counts: ScanProgressCounts;
  terminal: boolean;
}

export type ScanProgressEmitInput = {
  workspaceId: string;
  scanJobId: string;
  type: ScanProgressEventType;
  phase: ScanProgressPhase;
  status: ScanJobStatus;
  message: string;
  percent?: number;
  counts?: Partial<ScanProgressCounts>;
  terminal?: boolean;
  /** Force emit even if within throttle window (terminal always forces). */
  force?: boolean;
};

export const SCAN_PROGRESS_CHANNEL_PREFIX = 'scan:progress:';

export function scanProgressChannel(scanJobId: string): string {
  return `${SCAN_PROGRESS_CHANNEL_PREFIX}${scanJobId}`;
}

export function emptyCounts(): ScanProgressCounts {
  return {
    reposDiscovered: 0,
    reposProcessed: 0,
    reposFailed: 0,
    reposTotal: 0,
    findingsCreated: 0,
    findingsUpdated: 0,
    queriesTotal: 0,
    queriesCompleted: 0,
    reposSkipped: 0,
    reposRescanned: 0,
    reposResumed: 0,
    reposPendingAnalysis: 0,
    findingsNew: 0,
    findingsUnchanged: 0,
    findingsReopened: 0,
    findingsResolved: 0,
    findingsHighRisk: 0,
  };
}

export function isTerminalProgressType(type: ScanProgressEventType): boolean {
  return (
    type === ScanProgressEventType.COMPLETED ||
    type === ScanProgressEventType.FAILED ||
    type === ScanProgressEventType.CANCELLED
  );
}

/** Compute a safe 0–100 percent from job counters. */
export function computeProgressPercent(input: {
  status: ScanJobStatus;
  phase: ScanProgressPhase;
  counts: ScanProgressCounts;
}): number {
  if (
    input.status === ScanJobStatus.COMPLETED ||
    input.status === ScanJobStatus.PARTIALLY_COMPLETED ||
    input.phase === ScanProgressPhase.COMPLETED
  ) {
    return 100;
  }
  if (
    input.status === ScanJobStatus.FAILED ||
    input.status === ScanJobStatus.CANCELLED ||
    input.phase === ScanProgressPhase.FAILED ||
    input.phase === ScanProgressPhase.CANCELLED
  ) {
    return Math.min(
      99,
      Math.max(
        0,
        Math.round(
          input.counts.reposProcessed > 0
            ? (input.counts.reposProcessed /
                Math.max(
                  input.counts.reposTotal || input.counts.reposDiscovered || 1,
                  1,
                )) *
                90 +
                5
            : input.phase === ScanProgressPhase.QUEUED
              ? 0
              : 5,
        ),
      ),
    );
  }

  if (input.phase === ScanProgressPhase.QUEUED) return 0;
  if (input.phase === ScanProgressPhase.ORCHESTRATING) return 5;

  const queriesTotal = Math.max(input.counts.queriesTotal, 0);
  const queriesDone = Math.max(input.counts.queriesCompleted, 0);
  const searchShare =
    queriesTotal > 0 ? Math.min(1, queriesDone / queriesTotal) : 0;

  const total = Math.max(
    input.counts.reposTotal || input.counts.reposDiscovered || 0,
    0,
  );
  const processed = Math.max(input.counts.reposProcessed, 0);
  const analysisShare = total > 0 ? Math.min(1, processed / total) : 0;

  // Search ≈ 5–35%, analysis ≈ 35–95%, finalize 95–99 until terminal.
  if (input.phase === ScanProgressPhase.SEARCHING) {
    return Math.round(5 + searchShare * 30);
  }
  if (
    input.phase === ScanProgressPhase.ANALYZING ||
    input.phase === ScanProgressPhase.FINALIZING
  ) {
    return Math.round(35 + analysisShare * 60);
  }
  return Math.min(95, Math.round(5 + searchShare * 30 + analysisShare * 60));
}
