import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Security Team' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;
}

export class SetGithubTokenDto {
  @ApiProperty({
    example: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    description:
      'A GitHub personal access token scoped for public read. Encrypted at rest; only the last 4 characters are ever shown back.',
  })
  @IsString()
  @MinLength(20)
  @MaxLength(255)
  token!: string;
}
