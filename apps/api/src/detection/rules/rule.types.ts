import { DetectionResult } from '../../common/enums';

export interface RepoAnalysisContext {
  fullName: string;
  owner: string;
  name: string;
  description: string;
  topics: string[];
  language: string;
  stars: number;
  forks: number;
  isFork: boolean;
  githubCreatedAt?: Date;
  githubPushedAt?: Date;
  filePaths: string[];
  readmeText: string;
  smallFileTexts: Array<{ path: string; content: string }>;
  matchedBrandName?: string;
  matchedBrandAliases?: string[];
}

export interface DetectionRule {
  id: string;
  name: string;
  evaluate(
    ctx: RepoAnalysisContext,
  ): DetectionResult | DetectionResult[] | null;
}
