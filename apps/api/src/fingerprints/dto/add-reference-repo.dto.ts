import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

const GITHUB_NAME_RE = /^[A-Za-z0-9._-]+$/;

export class AddReferenceRepoDto {
  @ApiProperty({
    example: 'fynd-org',
    description: "The client's own GitHub account/org that owns this repo.",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(GITHUB_NAME_RE, {
    message: 'owner must be a valid GitHub login/org name',
  })
  owner!: string;

  @ApiProperty({ example: 'web-frontend' })
  @IsString()
  @IsNotEmpty()
  @Matches(GITHUB_NAME_RE, {
    message: 'repo must be a valid GitHub repository name',
  })
  repo!: string;
}
