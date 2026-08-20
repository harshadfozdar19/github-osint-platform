import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class KeywordRotationSlotDto {
  @ApiProperty({
    description:
      "The company this keyword belongs to - a queue can mix several companies' keywords.",
  })
  @IsMongoId()
  brandId!: string;

  @ApiProperty({ example: 'motilal oswal' })
  @IsString()
  keyword!: string;

  @ApiProperty({
    example: 300_000,
    description:
      "This keyword's own turn length in milliseconds (hh:mm:ss, converted client-side) - between 1s and 24h.",
  })
  @IsInt()
  @Min(1_000)
  @Max(24 * 60 * 60_000)
  durationMs!: number;

  @ApiPropertyOptional({
    enum: ['both', 'repositories', 'code'],
    default: 'both',
    description:
      "Which GitHub search kind(s) this keyword's turn should run - 'both' (default), 'repositories' search only, or 'code' search only.",
  })
  @IsOptional()
  @IsIn(['both', 'repositories', 'code'])
  searchScope?: 'both' | 'repositories' | 'code';

  @ApiPropertyOptional({
    default: true,
    description:
      "Resume this keyword's queries from its own discovery cursor (true, the default) instead of restarting every query at page 1 on every turn (false).",
  })
  @IsOptional()
  @IsBoolean()
  continueDiscovery?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      "Whether this keyword should stay paused after this start/add call, instead of running. Start/add REPLACE-or-append the whole slot list, so a slot omitted here isn't just skipped - it's dropped from the queue entirely; passing paused:true is how an already-paused keyword survives a start call without being force-resumed.",
  })
  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}

export class StartKeywordRotationDto {
  @ApiProperty({
    type: [KeywordRotationSlotDto],
    description:
      'The user-built, user-ordered queue to run: exactly this sequence of keywords (each with its own company and duration), workspace-wide - can mix keywords from several different companies in one shared queue.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => KeywordRotationSlotDto)
  slots!: KeywordRotationSlotDto[];

  @ApiPropertyOptional({
    enum: ['any', 'dated'],
    default: 'any',
    description:
      "'any' (default) applies no created/pushed date restriction to any keyword in the queue - matches a plain GitHub search. 'dated' restricts every keyword to the createdFrom/createdTo/pushedFrom/pushedTo range below.",
  })
  @IsOptional()
  @IsIn(['any', 'dated'])
  dateFilterMode?: 'any' | 'dated';

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-12' })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  pushedFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-12' })
  @IsOptional()
  @IsDateString()
  pushedTo?: string;
}

export class AddKeywordRotationSlotsDto {
  @ApiProperty({
    type: [KeywordRotationSlotDto],
    description:
      'One or more keywords to append to the END of an already-running scheduler queue, without touching whichever keyword currently holds the turn or anything else already queued.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => KeywordRotationSlotDto)
  slots!: KeywordRotationSlotDto[];
}

export class KeywordRotationSlotRefDto {
  @ApiProperty({ description: 'The company the target keyword belongs to' })
  @IsMongoId()
  brandId!: string;

  @ApiProperty({
    example: 'motilal oswal',
    description: 'The exact keyword, as queued',
  })
  @IsString()
  keyword!: string;
}

export class SetKeywordRotationSlotSearchScopeDto extends KeywordRotationSlotRefDto {
  @ApiProperty({
    enum: ['both', 'repositories', 'code'],
    description:
      "Which GitHub search kind(s) this keyword's turn should run from now on.",
  })
  @IsIn(['both', 'repositories', 'code'])
  searchScope!: 'both' | 'repositories' | 'code';
}

export class SetKeywordRotationSlotContinueDiscoveryDto extends KeywordRotationSlotRefDto {
  @ApiProperty({
    description:
      "true resumes this keyword's queries from its own discovery cursor; false restarts every query at page 1 on every turn from now on.",
  })
  @IsBoolean()
  continueDiscovery!: boolean;
}
