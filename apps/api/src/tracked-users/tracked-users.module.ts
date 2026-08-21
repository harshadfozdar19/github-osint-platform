import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  TrackedGithubUser,
  TrackedGithubUserSchema,
} from './schemas/tracked-github-user.schema';
import { TrackedUsersService } from './tracked-users.service';
import { TrackedUsersController } from './tracked-users.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TrackedGithubUser.name, schema: TrackedGithubUserSchema },
    ]),
    forwardRef(() => WorkspacesModule),
  ],
  providers: [TrackedUsersService],
  controllers: [TrackedUsersController],
  exports: [TrackedUsersService],
})
export class TrackedUsersModule {}
