import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ScanMode } from '../../common/enums';

export class ManualScanDto {
  @ApiPropertyOptional({
    enum: ScanMode,
    default: ScanMode.INCREMENTAL,
    description:
      'incremental (default) skips unchanged repos; full forces content analysis; failed_only retries previously failed githubIds; analyze_pending runs content analysis on every repo a prior discoveryOnly scan found and saved but never analyzed - workspace-wide by default, or narrowed with brandId and/or discoveredFrom/discoveredTo and/or maxRepos (customQuery is still ignored - there is no search to scope by query text in this mode)',
  })
  @IsOptional()
  @IsEnum(ScanMode)
  mode?: ScanMode;

  @ApiPropertyOptional({
    description: 'Force a full content rescan even in incremental mode',
  })
  @IsOptional()
  @IsBoolean()
  forceFullScan?: boolean;

  @ApiPropertyOptional({
    description:
      'Force start the scan even if an active scan exists (cancels existing)',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({
    description:
      'Scope the scan to a single monitored brand (by id) instead of sweeping all enabled brands. Ignored if customQuery is set.',
  })
  @IsOptional()
  @IsMongoId()
  brandId?: string;

  @ApiPropertyOptional({
    example: 'phonepe apk in:name',
    description:
      'Scope the scan to one raw GitHub search query instead of generated brand/keyword queries. Takes priority over brandId.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  customQuery?: string;

  @ApiPropertyOptional({
    description:
      "Internal audit mode: instead of searching GitHub for repos that MENTION this brand (external impersonation/scam discovery), exhaustively enumerate every repo under the brand's own trustedGithubOwners accounts and scan those for exposed secrets. Requires brandId, and that brand must have at least one trustedGithubOwners entry configured. Ignored if customQuery is set.",
  })
  @IsOptional()
  @IsBoolean()
  internalAudit?: boolean;

  @ApiPropertyOptional({
    example: 'otp bypass',
    description:
      "Scope the scan to exactly ONE of the brand's own custom keywords - just that keyword's repo-search + code-search query pair, skipping phishing/apk/impersonation/typo-squat/trusted-account and the brand's other keywords. Requires brandId. Mutually exclusive with customQuery and internalAudit. Multiple keyword-scoped scans for the same brand can run concurrently (each gets its own active-scan slot).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiPropertyOptional({
    example: 'angel one "otp bypass" in:name,description',
    description:
      'User-edited override for the repo-search query keyword would otherwise auto-generate - used verbatim (including any date qualifier already baked in). Requires keyword; ignored without it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  customRepoQuery?: string;

  @ApiPropertyOptional({
    example: '"angel one" "otp bypass"',
    description:
      "User-edited override for the code-search query keyword would otherwise auto-generate. Requires keyword; ignored without it.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  customCodeQuery?: string;

  @ApiPropertyOptional({
    enum: ['repositories', 'code'],
    default: 'repositories',
    description: 'Search kind for customQuery',
  })
  @IsOptional()
  @IsIn(['repositories', 'code'])
  searchKind?: 'repositories' | 'code';

  @ApiPropertyOptional({
    example: 200,
    description:
      'How many repos to discover/analyze for this scan. Clamped to the admin-configured ceiling (SCAN_MAX_REPOS, unset by default - unbounded); omit to use that ceiling.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  maxRepos?: number;

  @ApiPropertyOptional({
    example: '2026-07-31',
    description:
      'Only consider repos created on/after this date (YYYY-MM-DD). Repository search only — invalid alongside searchKind=code.',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-02',
    description:
      'Only consider repos created on/before this date (YYYY-MM-DD). Repository search only — invalid alongside searchKind=code.',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    example: '2026-07-31',
    description:
      'Only consider repos last pushed to on/after this date (YYYY-MM-DD) - filters by recent activity, independent of createdFrom/createdTo which filter by repo creation date. Repository search only — invalid alongside searchKind=code.',
  })
  @IsOptional()
  @IsDateString()
  pushedFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-02',
    description:
      'Only consider repos last pushed to on/before this date (YYYY-MM-DD). Repository search only — invalid alongside searchKind=code.',
  })
  @IsOptional()
  @IsDateString()
  pushedTo?: string;

  @ApiPropertyOptional({
    enum: ['and', 'or'],
    default: 'and',
    description:
      "'or' matches repos satisfying EITHER the created OR the pushed date range (e.g. \"created today OR pushed today\"), instead of requiring both ('and', default). Only has an effect when both a created and a pushed range are set - GitHub's search syntax has no OR between two different qualifiers in one query, so 'or' mode issues two separate queries per family and merges the results.",
  })
  @IsOptional()
  @IsIn(['and', 'or'])
  dateFilterMode?: 'and' | 'or';

  @ApiPropertyOptional({
    description:
      "Resume each search query from where this workspace's discovery of it last left off, instead of every scan re-fetching the same most-recently-updated top results (GitHub search results are sorted by last-updated). Lets a large candidate pool be worked through in maxRepos-sized batches across multiple scans instead of only ever seeing the same top slice. Has no effect on internalAudit (which doesn't paginate a search).",
  })
  @IsOptional()
  @IsBoolean()
  continueDiscovery?: boolean;

  @ApiPropertyOptional({
    description:
      "Discover and save candidate repos (metadata only - name, description, topics, dates) without running content analysis on any of them. Maximizes discovery coverage cheaply now; run mode=analyze_pending later to actually clone/scan/detect on whatever's worth analyzing. Ignored for internalAudit.",
  })
  @IsOptional()
  @IsBoolean()
  discoveryOnly?: boolean;

  @ApiPropertyOptional({
    example: '2026-07-31',
    description:
      'mode=analyze_pending only: only analyze pending repos THIS WORKSPACE discovered on/after this date (YYYY-MM-DD) - Repository.createdAt, not any GitHub timestamp. Ignored for every other mode.',
  })
  @IsOptional()
  @IsDateString()
  discoveredFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-02',
    description:
      'mode=analyze_pending only: only analyze pending repos THIS WORKSPACE discovered on/before this date (YYYY-MM-DD). Ignored for every other mode.',
  })
  @IsOptional()
  @IsDateString()
  discoveredTo?: string;
}
