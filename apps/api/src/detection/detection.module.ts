import { Module } from '@nestjs/common';
import { DetectionEngine } from './detection.engine';
import { RiskScoringService } from './risk-scoring.service';

@Module({
  providers: [DetectionEngine, RiskScoringService],
  exports: [DetectionEngine, RiskScoringService],
})
export class DetectionModule {}
