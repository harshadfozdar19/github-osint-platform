import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { DetectionResult } from '../common/enums';
import { DetectionRule, RepoAnalysisContext } from './rules/rule.types';
import { secretDetectionRule } from './rules/secrets.rule';
import {
  brandImpersonationRule,
  customKeywordMatchRule,
  deploymentSignalRule,
  disposablePhishingRepoRule,
  fakeApkRule,
  lowReputationRule,
  malwareRule,
  obfuscationRule,
  phishingRule,
  suspiciousDestinationRule,
  suspiciousOwnerAccountRule,
} from './rules/threat.rules';

/** Bump when rule semantics change in a way that requires re-analysis. */
export const RULESET_SEMANTIC_VERSION = '2026.08.6';

/**
 * These rules only ever fire to answer "does this repo impersonate/scam
 * using the brand" - meaningless (and just noise) against a repo we already
 * know is the brand's own, confirmed via trustedGithubOwners enumeration
 * (internal secret audit). fakeApkRule is included here because it can only
 * ever fire when a brand match is present (`if (!brand) return null`) -
 * without that gate it's indistinguishable from "this is our own official
 * Android app repo". secretDetectionRule, phishingRule, malwareRule, and
 * obfuscationRule stay active for internal audits since they can each fire
 * from pure content patterns with no brand match required - a compromised
 * dependency or insider threat could trip them in the company's own repo
 * too, which is still worth surfacing.
 */
export const IMPERSONATION_ONLY_RULE_IDS = new Set([
  'brand-impersonation',
  'low-reputation-new-repo',
  'disposable-phishing-repo',
  'fake-apk',
  'custom-keyword-match',
  'suspicious-destination',
  'deployment-signal',
  'suspicious-owner-account',
]);

@Injectable()
export class DetectionEngine {
  private readonly rules: DetectionRule[] = [
    secretDetectionRule,
    brandImpersonationRule,
    phishingRule,
    fakeApkRule,
    malwareRule,
    lowReputationRule,
    obfuscationRule,
    disposablePhishingRepoRule,
    customKeywordMatchRule,
    suspiciousDestinationRule,
    deploymentSignalRule,
    suspiciousOwnerAccountRule,
  ];

  analyze(
    ctx: RepoAnalysisContext,
    options: { excludeRuleIds?: Set<string> } = {},
  ): DetectionResult[] {
    const results: DetectionResult[] = [];

    // No further dedup by ruleId here: each rule below returns at most one
    // result per invocation, except secretDetectionRule, which can
    // legitimately return several results sharing the same ruleId - one per
    // occurrence of the same credential pattern across different files/lines
    // - and those are meant to all survive, not collapse to one.
    for (const rule of this.rules) {
      if (options.excludeRuleIds?.has(rule.id)) continue;
      const output = rule.evaluate(ctx);
      if (!output) continue;
      if (Array.isArray(output)) {
        results.push(...output);
      } else {
        results.push(output);
      }
    }

    return results;
  }

  listRules() {
    return this.rules.map((r) => ({ id: r.id, name: r.name }));
  }

  /** Stable hash of active rule IDs + semantic version for incremental skip checks. */
  getRulesetVersion(): string {
    const ids = this.rules
      .map((r) => r.id)
      .sort()
      .join(',');
    return createHash('sha256')
      .update(`${RULESET_SEMANTIC_VERSION}:${ids}`)
      .digest('hex')
      .slice(0, 16);
  }
}
