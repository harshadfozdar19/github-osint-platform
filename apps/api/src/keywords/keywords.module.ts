import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Keyword, KeywordSchema } from './schemas/keyword.schema';
import { KeywordsService } from './keywords.service';
import { KeywordsController } from './keywords.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Keyword.name, schema: KeywordSchema }]),
    WorkspacesModule,
  ],
  providers: [KeywordsService],
  controllers: [KeywordsController],
  exports: [KeywordsService],
})
export class KeywordsModule {}
