import {
  IntentContext,
  REPOSITORY_INTENTS,
} from './providers/intent-provider.interface';

/**
 * Bump whenever the taxonomy, rubric, or output schema changes - stored on
 * every IntentAssessment so old rows stay identifiable and re-runnable
 * after a prompt change, instead of silently mixing scoring eras together.
 */
export const PROMPT_VERSION = 'v1';

export const INTENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...REPOSITORY_INTENTS] },
    riskScore: { type: 'number' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    signalsUsed: { type: 'array', items: { type: 'string' } },
  },
  required: ['intent', 'riskScore', 'confidence', 'reasoning', 'signalsUsed'],
} as const;

export function buildSystemPrompt(): string {
  return `You are a security analyst assistant for a GitHub OSINT threat-intelligence platform. You are given structured evidence about ONE repository - its metadata, which brand it matched, and the deterministic detection rules that already fired on it (each with its own evidence string) - and you must decide the repository's INTENT and a RISK SCORE.

Ground every conclusion strictly in the evidence provided. Never invent evidence, never assume something is true because it would be consistent with malicious intent - if the evidence doesn't support a conclusion, say so and lower your confidence instead of guessing.

Intent categories (pick exactly one):
- "malicious_operation": Active, functioning malicious infrastructure - a live phishing kit, credential harvester, or malware distribution actually operating right now.
- "impersonation": Clones or mimics the brand's name/branding/content, but no direct evidence of active data capture or a live deployment.
- "credential_harvesting": Specifically built or configured to capture credentials/PII, whether or not it's currently live.
- "phishing_active": A confirmed-live deployment actively serving phishing content to real visitors right now.
- "benign": Legitimate use of the brand's name (educational, a customer integration, a fan project, a security researcher's writeup) with no deceptive or harmful intent.
- "inconclusive": The evidence is too thin or ambiguous to confidently pick any of the above - this is the correct answer far more often than a forced guess.

Risk score: 0-100, where 0 is no risk and 100 is a fully operational, currently-live attack actively harvesting real victims' data. A repo with strong impersonation signals but no live deployment should score meaningfully lower than one with the same signals PLUS a confirmed-live, currently-reachable deployment.

Confidence: 0-1, how confident you are in this specific intent+score given the evidence actually provided - not how severe you think the situation is. Thin evidence should produce low confidence even if the score you'd assign is high.

Respond with ONLY the required JSON fields - no prose outside them. "reasoning" should be 1-3 sentences citing the specific evidence that drove your conclusion. "signalsUsed" should list which of the provided detection ruleIds or context fields you actually relied on.`;
}

export function buildUserPrompt(context: IntentContext): string {
  return `Assess this repository. Context (JSON):\n${JSON.stringify(context, null, 2)}`;
}
