export interface IntentContext {
  repository: {
    fullName: string;
    owner: string;
    description: string;
    topics: string[];
    language: string;
    stars: number;
    forks: number;
    isFork: boolean;
    githubCreatedAt?: string;
    githubPushedAt?: string;
    otherReposByOwnerInWorkspace: number;
  };
  brand?: {
    name: string;
    matchType?: string;
    matchLocation?: string;
    matchedAlias?: string;
    matchedText?: string;
  };
  deployment?: {
    url: string;
    state: string;
    confirmedLive: boolean;
  };
  finding: {
    severity: string;
    riskScore: number;
    categories: string[];
    origin: 'internal' | 'external';
  };
  /** Curated evidence already extracted by the deterministic rule engine - not raw file dumps. */
  detections: Array<{
    ruleId: string;
    category: string;
    severity: string;
    confidence: number;
    evidence: string;
    explanation: string;
  }>;
}

export const REPOSITORY_INTENTS = [
  'malicious_operation',
  'impersonation',
  'credential_harvesting',
  'phishing_active',
  'benign',
  'inconclusive',
] as const;

export type RepositoryIntentValue = (typeof REPOSITORY_INTENTS)[number];

export interface IntentResult {
  intent: RepositoryIntentValue;
  riskScore: number;
  confidence: number;
  reasoning: string;
  signalsUsed: string[];
  model: string;
}

export interface IntentProvider {
  readonly name: string;
  assess(context: IntentContext): Promise<IntentResult>;
}

export class IntentProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
  }
}
