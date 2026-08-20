import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { FindingListStatus } from '../../common/enums';

export class UpdateFindingListStatusDto {
  @ApiProperty({ enum: FindingListStatus })
  @IsEnum(FindingListStatus)
  listStatus!: FindingListStatus;
}
