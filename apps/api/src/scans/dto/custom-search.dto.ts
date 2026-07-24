import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CustomSearchQueryDto {
  @ApiProperty({
    example: 'phonepe apk in:name',
    description: 'GitHub search query string',
  })
  @IsString()
  @IsNotEmpty()
  q!: string;

  @ApiProperty({ example: '1', required: false, default: '1' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiProperty({
    enum: ['repositories', 'code'],
    required: false,
    default: 'repositories',
  })
  @IsOptional()
  @IsIn(['repositories', 'code'])
  type?: 'repositories' | 'code';
}
