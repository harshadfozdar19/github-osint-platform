import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'crypto';
import {
  DiscoveryCursor,
  DiscoveryCursorDocument,
} from './schemas/discovery-cursor.schema';

function hashQuery(kind: string, query: string): string {
  return createHash('sha256').update(`${kind}:${query}`, 'utf8').digest('hex');
}

/**
 * Cross-scan continuation for GitHub search discovery - see DiscoveryCursor
 * for why this can't just live on ScanJob.checkpoint. Reads are opt-in per
 * scan (scan.continueDiscovery); writes are unconditional so a workspace's
 * discovery history is captured regardless, ready for whenever a scan does
 * opt in.
 */
@Injectable()
export class DiscoveryCursorService {
  constructor(
    @InjectModel(DiscoveryCursor.name)
    private readonly cursorModel: Model<DiscoveryCursorDocument>,
  ) {}

  /** Next page to request for this exact query in this workspace - 1 if never seen before or previously exhausted. */
  async getResumePage(
    workspaceId: string,
    kind: 'repositories' | 'code',
    query: string,
  ): Promise<number> {
    const cursor = await this.cursorModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        kind,
        queryHash: hashQuery(kind, query),
      })
      .lean()
      .exec();
    if (!cursor || cursor.exhausted) return 1;
    return cursor.lastPage + 1;
  }

  /** Records the last page actually completed for this query, so a future scan can continue past it (or restart at 1 once exhausted). */
  async saveCursor(
    workspaceId: string,
    kind: 'repositories' | 'code',
    query: string,
    page: number,
    exhausted: boolean,
  ): Promise<void> {
    await this.cursorModel
      .updateOne(
        {
          workspaceId: new Types.ObjectId(workspaceId),
          kind,
          queryHash: hashQuery(kind, query),
        },
        { $set: { query, lastPage: page, exhausted } },
        { upsert: true },
      )
      .exec();
  }
}
