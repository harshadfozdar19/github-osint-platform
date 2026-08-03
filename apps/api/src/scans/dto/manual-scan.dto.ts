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
      'incremental (default) skips unchanged repos; full forces content analysis; failed_only retries previously failed githubIds',
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
      'How many repos to discover/analyze for this scan. Clamped to the admin-configured ceiling (SCAN_MAX_REPOS); omit to use that ceiling.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
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
}
