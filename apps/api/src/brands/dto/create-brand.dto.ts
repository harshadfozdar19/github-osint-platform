import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ example: 'FYND' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    example: 'Fintech and OSINT threat intelligence services',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: ['fynd'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  aliases?: string[];

  @ApiProperty({ example: ['fynd'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  keywords?: string[];

  @ApiProperty({
    example: ['fynd-org'],
    required: false,
    description:
      "This brand's own real GitHub org/user accounts, if known - lets discovery scan everything they push regardless of keyword matches, and attributes matches to this brand even without a name match.",
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  trustedGithubOwners?: string[];

  @ApiProperty({ example: true, default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class UpdateBrandFullDto {
  @ApiProperty({ example: 'FYND', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: 'Description here', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: ['fynd'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  aliases?: string[];

  @ApiProperty({ example: ['fynd'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  keywords?: string[];

  @ApiProperty({ example: ['fynd-org'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  trustedGithubOwners?: string[];

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
