export class GitHubClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'AUTH'
      | 'PERMISSION'
      | 'VALIDATION'
      | 'NOT_FOUND'
      | 'RATE_LIMIT'
      | 'SECONDARY_RATE_LIMIT'
      | 'NETWORK'
      | 'TIMEOUT'
      | 'CANCELLED'
      | 'BUDGET'
      | 'UNKNOWN',
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'GitHubClientError';
  }

  get retryable(): boolean {
    // Primary/secondary quota pauses are coordinated via Redis + BullMQ delay,
    // not tight in-process retries.
    return this.code === 'NETWORK' || this.code === 'TIMEOUT';
  }
}

export function isGitHubClientError(
  error: unknown,
): error is GitHubClientError {
  return error instanceof GitHubClientError;
}
