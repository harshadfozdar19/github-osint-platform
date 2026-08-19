const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

export type ScanProgressEventType =
  | 'scan.queued'
  | 'scan.started'
  | 'scan.search_progress'
  | 'scan.repositories_discovered'
  | 'scan.repositories_processed'
  | 'scan.findings_created'
  | 'scan.warning'
  | 'scan.completed'
  | 'scan.failed'
  | 'scan.cancelled';

export type ScanProgressPhase =
  | 'queued'
  | 'orchestrating'
  | 'searching'
  | 'analyzing'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScanProgressCounts {
  reposDiscovered: number;
  reposProcessed: number;
  reposFailed: number;
  reposTotal: number;
  findingsCreated: number;
  findingsUpdated: number;
  queriesTotal: number;
  queriesCompleted: number;
  reposSkipped?: number;
  reposRescanned?: number;
  reposResumed?: number;
  reposPendingAnalysis?: number;
  findingsNew?: number;
  findingsUnchanged?: number;
  findingsReopened?: number;
  findingsResolved?: number;
  /** Repos processed in this scan whose finding came out HIGH or CRITICAL severity - "how many are actually a real threat". */
  findingsHighRisk?: number;
}

export interface ScanProgressEvent {
  scanJobId: string;
  workspaceId: string;
  seq: number;
  type: ScanProgressEventType;
  phase: ScanProgressPhase;
  status: string;
  percent: number;
  message: string;
  timestamp: string;
  counts: ScanProgressCounts;
  terminal: boolean;
}

function authHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
  };
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('accessToken');
    const workspaceId = localStorage.getItem('workspaceId');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  }
  return headers;
}

function parseSseChunk(
  chunk: string,
  onEvent: (event: ScanProgressEvent) => void,
) {
  const blocks = chunk.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventType = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data || eventType === 'heartbeat') continue;
    try {
      const parsed = JSON.parse(data) as ScanProgressEvent | { ping?: boolean };
      if ('ping' in parsed) continue;
      if (typeof (parsed as ScanProgressEvent).seq === 'number') {
        onEvent(parsed as ScanProgressEvent);
      }
    } catch {
      // ignore malformed frames
    }
  }
}

/**
 * Authenticated SSE via fetch (supports Authorization header).
 * Returns an abort function. Falls back to the caller's polling when this rejects.
 */
export async function openScanProgressStream(
  scanId: string,
  afterSeq: number,
  onEvent: (event: ScanProgressEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${API_URL}/scans/${scanId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}`,
    {
      method: 'GET',
      headers: authHeaders(),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    throw new Error(`SSE unavailable (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      parseSseChunk(part + '\n\n', onEvent);
    }
  }
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case 'queued':
      return 'Queued';
    case 'orchestrating':
      return 'Starting';
    case 'searching':
      return 'Searching GitHub';
    case 'analyzing':
      return 'Analyzing repositories';
    case 'finalizing':
      return 'Finalizing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return phase;
  }
}
