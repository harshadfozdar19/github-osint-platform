import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { FindingStatus } from '../../common/enums';

export class UpdateFindingStatusDto {
  @ApiProperty({ enum: FindingStatus })
  @IsEnum(FindingStatus)
  status!: FindingStatus;

  @ApiPropertyOptional({
    description: 'Analyst note for triage decision',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
