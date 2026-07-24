import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { DetectionResult } from '../common/enums';
import { DetectionRule, RepoAnalysisContext } from './rules/rule.types';
import { secretDetectionRule } from './rules/secrets.rule';
import {
  brandImpersonationRule,
  fakeApkRule,
  lowReputationRule,
  malwareRule,
  obfuscationRule,
  phishingRule,
} from './rules/threat.rules';

/** Bump when rule semantics change in a way that requires re-analysis. */
export const RULESET_SEMANTIC_VERSION = '2026.07.2';

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
  ];

  analyze(ctx: RepoAnalysisContext): DetectionResult[] {
    const results: DetectionResult[] = [];

    for (const rule of this.rules) {
      const output = rule.evaluate(ctx);
      if (!output) continue;
      if (Array.isArray(output)) {
        results.push(...output);
      } else {
        results.push(output);
      }
    }

    const seen = new Set<string>();
    return results.filter((r) => {
      if (seen.has(r.ruleId)) return false;
      seen.add(r.ruleId);
      return true;
    });
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
