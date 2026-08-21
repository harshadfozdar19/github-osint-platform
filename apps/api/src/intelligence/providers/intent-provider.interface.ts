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
  /** Repeat-operator behavioral signals - same account/identity showing up against other brands or under a different owner. */
  operatorSignals: {
    /** Distinct other monitored brands this same GitHub account already has active findings against in this workspace. */
    otherBrandsHit: number;
    /** Distinct other GitHub owners sharing one of this repo's own contact/wallet fingerprints (email, Telegram, wallet address, etc.). */
    linkedIdentityOwners: number;
  };
  contributors: {
    /** How many distinct GitHub accounts have committed to this repo. */
    count: number;
    /** How many of those same accounts also contribute to other repos in this workspace. */
    overlapWithOtherRepos: number;
  };
  /** Per-detection credential verification outcome, where a secret-type detection has been checked. Never the raw secret value. */
  credentials: Array<{ type: string; verificationStatus: string }>;
  trustSignals: {
    /** True if this repo's owner is on the matched brand's own trustedGithubOwners allowlist. */
    isTrustedOwner: boolean;
  };
}

/**
 * Extra, deliberately bounded raw-repository context assembled only for a
 * Tier-2 "deep review" pass, when Tier 1 was inconclusive/low-confidence.
 * Every text field has already been through redactSecretsInText() - see
 * DeepIntentContextBuilder. Still not "the whole repository" - a capped
 * README excerpt, a capped top-level file listing, an optional manifest,
 * and up to a few files the rule engine itself already flagged.
 */
export interface DeepIntentContext {
  readme?: { path?: string; text: string; truncated: boolean };
  rootPaths?: string[];
  manifest?: { path: string; text: string };
  flaggedFiles: Array<{ path: string; text: string }>;
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

export const FACTOR_DIRECTIONS = [
  'supports_malicious',
  'supports_benign',
  'neutral',
] as const;

export type FactorDirection = (typeof FACTOR_DIRECTIONS)[number];

export interface IntentFactor {
  factor: string;
  direction: FactorDirection;
  /** Must reference something actually present in the supplied context - see validateCitations. */
  evidenceReferences: string[];
}

export interface IntentResult {
  intent: RepositoryIntentValue;
  riskScore: number;
  confidence: number;
  reasoning: string;
  signalsUsed: string[];
  factors: IntentFactor[];
  /** What the model would need to see to be more confident - never invented, an honest gap list. */
  missingInformation: string[];
  needsDeepReview: boolean;
  model: string;
}

export interface IntentAssessOptions {
  /** Overrides the default Tier-1 user prompt - used to hand a Tier-2 pass the extra deep-review context. */
  userPrompt?: string;
  /** Overrides the provider's configured default model - used to route Tier-2 to a stronger model when configured. */
  modelOverride?: string;
}

export interface IntentProvider {
  readonly name: string;
  assess(
    context: IntentContext,
    options?: IntentAssessOptions,
  ): Promise<IntentResult>;
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
