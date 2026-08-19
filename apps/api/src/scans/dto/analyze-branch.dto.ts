import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { SAFE_BRANCH_RE } from '../branch-name.util';

export class AnalyzeBranchDto {
  @ApiProperty({
    example: 'feature/new-checkout',
    description:
      'The exact branch name to clone and scan - not necessarily the default branch. Sent in the body rather than the URL path since branch names can contain "/".',
  })
  @Matches(SAFE_BRANCH_RE, {
    message:
      'branch must be a valid git ref name (letters, digits, ".", "_", "-", "/" - no leading "-", no "..")',
  })
  branch!: string;
}
