import { Injectable } from '@nestjs/common';
import {
  DetectionResult,
  RiskBreakdownItem,
  Severity,
  severityFromScore,
} from '../common/enums';
import { RepoAnalysisContext } from './rules/rule.types';

export interface RiskScoreResult {
  score: number;
  severity: Severity;
  breakdown: RiskBreakdownItem[];
}

@Injectable()
export class RiskScoringService {
  calculate(
    detections: DetectionResult[],
    ctx: RepoAnalysisContext,
  ): RiskScoreResult {
    const breakdown: RiskBreakdownItem[] = [];
    let score = 0;

    for (const d of detections) {
      const points = Math.round(
        d.riskContribution * (0.5 + d.confidence * 0.5),
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

    // Reputation modifiers
    if (ctx.stars >= 1000) {
      const points = -12;
      score += points;
      breakdown.push({
        factor: 'High repository reputation',
        points,
        detail: `Repository has ${ctx.stars} stars — reduces impersonation likelihood.`,
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

    score = Math.max(0, Math.min(100, Math.round(score)));

    return {
      score,
      severity: severityFromScore(score),
      breakdown,
    };
  }
}
