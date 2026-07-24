import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateKeywordDto {
  @ApiProperty({ example: 'paypal' })
  @IsString()
  @IsNotEmpty()
  keyword!: string;

  @ApiProperty({ example: 'phishing', default: 'general' })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ example: 5, default: 5 })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  priority?: number;

  @ApiProperty({ example: true, default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class UpdateKeywordDto {
  @ApiProperty({ example: 'paypal', required: false })
  @IsString()
  @IsOptional()
  keyword?: string;

  @ApiProperty({ example: 'phishing', required: false })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ example: 5, required: false })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  priority?: number;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
