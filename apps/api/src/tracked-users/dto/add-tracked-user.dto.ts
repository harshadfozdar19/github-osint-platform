import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// GitHub's own username rules: alphanumeric or single hyphens, never
// leading/trailing/doubled, max 39 chars.
const GITHUB_USERNAME_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export class AddTrackedUserDto {
  @ApiProperty({ example: 'octocat' })
  @IsString()
  @Matches(GITHUB_USERNAME_RE, {
    message: 'Not a valid GitHub username',
  })
  username!: string;

  @ApiPropertyOptional({
    description:
      'Optional note - e.g. which repo/finding first surfaced this person',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
