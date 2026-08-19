import { Injectable } from '@nestjs/common';
import {
  DetectionResult,
  RiskBreakdownItem,
  Severity,
  severityFromScore,
} from '../common/enums';
import { MALICIOUS_INTENT_CATEGORIES } from '../common/threat-classification';
import { RepoAnalysisContext } from './rules/rule.types';

export interface RiskScoreResult {
  score: number;
  severity: Severity;
  breakdown: RiskBreakdownItem[];
}

export interface OperatorContext {
  /** Distinct other monitored brands this same account already has findings against in this workspace. */
  otherBrandsHit: number;
  /** Distinct other GitHub owners sharing an identical contact/wallet fingerprint with this repo. */
  linkedIdentityOwners?: number;
}

@Injectable()
export class RiskScoringService {
  calculate(
    detections: DetectionResult[],
    ctx: RepoAnalysisContext,
    operatorContext?: OperatorContext,
  ): RiskScoreResult {
    const breakdown: RiskBreakdownItem[] = [];
    let score = 0;

    // Several rules (secrets, custom-keyword matches, suspicious
    // destinations) can legitimately return multiple detections sharing one
    // ruleId - one per occurrence across different files/lines. Without any
    // diminishing effect, sheer repeat count of a single weak-to-moderate
    // rule (a dozen generic-api-token matches, five suspicious-destination
    // hits at 0.7 confidence, twenty custom-keyword hits) could stack up
    // linearly and single-handedly max the score out to CRITICAL regardless
    // of how convincing any one of them is on its own. Rank each detection
    // against only its own ruleId's other occurrences (strongest first) and
    // decay repeats geometrically so additional hits of the *same* signal
    // keep adding but with fast-shrinking effect, while a genuinely diverse
    // set of *different* rules firing is unaffected (each ruleId only ever
    // competes against its own repeats) and still rewarded by the
    // "Independent rule diversity bonus" below.
    const RULE_REPEAT_DECAY = 0.6;
    const rawPoints = (d: DetectionResult) =>
      d.riskContribution * (0.5 + d.confidence * 0.5);

    const groupsByRuleId = new Map<string, DetectionResult[]>();
    for (const d of detections) {
      const list = groupsByRuleId.get(d.ruleId) ?? [];
      list.push(d);
      groupsByRuleId.set(d.ruleId, list);
    }
    const repeatRank = new Map<DetectionResult, number>();
    for (const group of groupsByRuleId.values()) {
      [...group]
        .sort((a, b) => rawPoints(b) - rawPoints(a))
        .forEach((d, i) => repeatRank.set(d, i));
    }

    for (const d of detections) {
      const rank = repeatRank.get(d) ?? 0;
      const points = Math.round(
        rawPoints(d) * Math.pow(RULE_REPEAT_DECAY, rank),
      );
      score += points;
      breakdown.push({
        factor: d.ruleName,
        points,
        detail: d.explanation,
      });
    }

    // Independent rule diversity bonus
    const uniqueCategories = new Set(detections.map((d) => d.category));
    if (uniqueCategories.size >= 3) {
      const points = 10;
      score += points;
      breakdown.push({
        factor: 'Multiple threat categories',
        points,
        detail: `${uniqueCategories.size} independent categories triggered.`,
      });
    } else if (uniqueCategories.size === 2) {
      const points = 5;
      score += points;
      breakdown.push({
        factor: 'Multiple threat categories',
        points,
        detail: 'Two independent categories triggered.',
      });
    }

    // Reputation/age modifiers - these all answer one question: "does this
    // look like a fake/throwaway account built to impersonate someone?" That
    // question is only relevant to malicious-intent findings (impersonation,
    // phishing, fake APK, malware). A pure credential-exposure finding - a
    // company's own real, established, popular repo that someone forgot to
    // keep a secret out of - is exactly the profile these modifiers used to
    // discount, which silently downgraded genuine high-value leaks. Gate all
    // three behind an actual malicious-intent signal so they only fire where
    // the reasoning applies.
    const hasMaliciousIntentSignal = detections.some((d) =>
      MALICIOUS_INTENT_CATEGORIES.includes(d.category),
    );

    // Organic, genuinely-used repos convert roughly 9-24% of their stars
    // into forks; stars bought in bulk to launder a scam repo's legitimacy
    // (real, documented, ~3 cents each) essentially never convert to forks,
    // since nobody who bought a star is actually using the code. Set well
    // below the low end of that organic baseline - this only needs to catch
    // stars that clearly aren't converting to any real usage at all, not
    // penalize a repo with a merely below-average (but still real) fork
    // culture.
    const MIN_ORGANIC_FORK_RATIO = 0.02;
    const starsLookOrganic =
      ctx.stars > 0 && ctx.forks / ctx.stars >= MIN_ORGANIC_FORK_RATIO;

    if (hasMaliciousIntentSignal) {
      if (ctx.stars >= 1000 && starsLookOrganic) {
        const points = -12;
        score += points;
        breakdown.push({
          factor: 'High repository reputation',
          points,
          detail: `Repository has ${ctx.stars} stars and ${ctx.forks} forks (ratio consistent with organic usage) — reduces impersonation likelihood.`,
        });
      } else if (ctx.stars >= 1000 && !starsLookOrganic) {
        const points = 6;
        score += points;
        breakdown.push({
          factor: 'Possibly inflated stars',
          points,
          detail: `Repository has ${ctx.stars} stars but only ${ctx.forks} forks (${(ctx.stars > 0 ? (ctx.forks / ctx.stars) * 100 : 0).toFixed(1)}% fork ratio) — well below the organic baseline (~9-24%), consistent with purchased/bot-inflated stars rather than real usage. Not treated as a reputation signal.`,
        });
      } else if (ctx.stars <= 1) {
        const points = 6;
        score += points;
        breakdown.push({
          factor: 'Very low popularity',
          points,
          detail:
            'Near-zero stars increases risk when brand/phishing signals exist.',
        });
      }

      if (ctx.githubCreatedAt) {
        const ageDays =
          (Date.now() - ctx.githubCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays <= 14 && detections.length > 0) {
          const points = 8;
          score += points;
          breakdown.push({
            factor: 'Very new repository',
            points,
            detail: `Created ~${Math.round(ageDays)} days ago.`,
          });
        }
      }
    }

    // A single flagged repo could be a coincidence. The same account behind
    // repos already flagged for multiple *different* monitored brands is a
    // real behavioral fingerprint of a serial operator, not one-off luck -
    // worth its own line so an analyst sees *why* this one carries extra
    // weight instead of it just quietly padding the total.
    if (operatorContext && operatorContext.otherBrandsHit > 0) {
      const points = Math.min(20, 8 + operatorContext.otherBrandsHit * 6);
      score += points;
      breakdown.push({
        factor: 'Repeat operator pattern',
        points,
        detail: `This account already has repos flagged against ${operatorContext.otherBrandsHit} other monitored brand${operatorContext.otherBrandsHit === 1 ? '' : 's'} in this workspace.`,
      });
    }

    // A shared GitHub owner is one signal of a repeat operator; an identical
    // contact email/wallet/handle showing up under a *different* owner is a
    // stronger one - the GitHub account is disposable, but the payout
    // channel or contact point behind it usually isn't. Weighted higher than
    // the same-owner signal above for that reason.
    if (operatorContext && (operatorContext.linkedIdentityOwners || 0) > 0) {
      const linked = operatorContext.linkedIdentityOwners as number;
      const points = Math.min(30, 15 + linked * 8);
      score += points;
      breakdown.push({
        factor: 'Linked to other GitHub identities',
        points,
        detail: `Shares an identical contact/wallet fingerprint with ${linked} other GitHub account${linked === 1 ? '' : 's'} in this workspace.`,
      });
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    return {
      score,
      severity: severityFromScore(score),
      breakdown,
    };
  }
}
