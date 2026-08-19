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
  /**
   * The OWNER's GitHub account creation date - not the repo's. Only
   * populated once a brand has actually matched (see fetchRepositoryContext)
   * since it costs an extra GitHub API call and is only meaningful for
   * judging whether an account looks like a throwaway built to impersonate
   * someone. Undefined whenever that fetch didn't run or the account lookup
   * failed - never treat "undefined" as "this account is old and trusted."
   */
  ownerAccountCreatedAt?: Date;
  /** The owner account's public follower count - see ownerAccountCreatedAt for when this is populated. */
  ownerFollowers?: number;
  /** The owner account's public repo count - see ownerAccountCreatedAt for when this is populated. */
  ownerPublicRepos?: number;
  filePaths: string[];
  readmeText: string;
  /** Actual repo-relative path the README was read from (case/extension varies per repo) - used to link findings back to a real file instead of a literal "readme". Undefined if the repo has no README. */
  readmePath?: string;
  smallFileTexts: Array<{ path: string; content: string }>;
  /** DB id of the matched brand - needed to link a Finding back to its MonitoredBrand record. */
  matchedBrandId?: string;
  matchedBrandName?: string;
  matchedBrandAliases?: string[];
  /** This brand's own known GitHub accounts, if any - see common/brand-match.ts. */
  matchedBrandTrustedOwners?: string[];
  /** This brand's own user-curated "Search keywords" (Companies/Brand page) - see findKeywordMatches in common/brand-match.ts. */
  matchedBrandKeywords?: string[];
  /** Recent commit messages/author names, when git-history scanning is enabled - additional brand-match evidence sources. */
  commitMessages?: string[];
  commitAuthors?: string[];
  /**
   * Every (alias, file, line) hit from a full-repo `git grep` over the
   * WHOLE cloned tree - not limited to the maxFiles-capped `smallFileTexts`
   * sample above. Only populated when the clone-based scan path ran; the
   * REST fallback (git unavailable, repo too large, or clone-scan disabled)
   * has no equivalent and leaves this undefined.
   */
  brandFileMatches?: Array<{
    alias: string;
    path: string;
    lineNumber: number;
    line: string;
  }>;
  /**
   * Same full-repo `git grep` depth as brandFileMatches, but for this
   * brand's own curated keywords instead of its name/aliases - `alias` here
   * holds the matched keyword text. Only populated when the clone-based
   * scan path ran.
   */
  keywordFileMatches?: Array<{
    alias: string;
    path: string;
    lineNumber: number;
    line: string;
  }>;
  /**
   * Raw `git grep` hits (not yet verified) on literal secret-pattern anchors
   * across the WHOLE repo tree - see SECRET_GREP_ANCHORS in secrets.rule.ts,
   * which re-applies the real regexes to these lines before treating any of
   * them as an actual finding. Only populated when the clone-based scan path
   * ran.
   */
  fullRepoSecretCandidates?: Array<{
    path: string;
    lineNumber: number;
    line: string;
  }>;
}

export interface DetectionRule {
  id: string;
  name: string;
  evaluate(
    ctx: RepoAnalysisContext,
  ): DetectionResult | DetectionResult[] | null;
}
