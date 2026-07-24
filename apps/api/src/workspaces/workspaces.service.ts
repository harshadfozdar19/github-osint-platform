import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { WorkspaceMemberStatus, WorkspaceRole } from '../common/enums';
import { Workspace, WorkspaceDocument } from './schemas/workspace.schema';
import {
  WorkspaceMember,
  WorkspaceMemberDocument,
} from './schemas/workspace-member.schema';
import { UsersService } from '../users/users.service';
import { BrandsService } from '../brands/brands.service';
import {
  decryptSecret,
  encryptSecret,
  maskToken,
} from '../common/utils/token-crypto';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);
  /** Short-lived in-memory cache so every GitHub call doesn't hit Mongo + decrypt. */
  private readonly tokenCache = new Map<
    string,
    { token: string | undefined; expiresAt: number }
  >();
  private static readonly TOKEN_CACHE_TTL_MS = 60_000;

  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<WorkspaceDocument>,
    @InjectModel(WorkspaceMember.name)
    private readonly memberModel: Model<WorkspaceMemberDocument>,
    private readonly usersService: UsersService,
    @Inject(forwardRef(() => BrandsService))
    private readonly brandsService: BrandsService,
    private readonly config: ConfigService,
  ) {}

  async createForUser(userId: string, name: string, isDefault = false) {
    const base = slugify(name) || 'workspace';
    let slug = base;
    let attempt = 0;
    while (await this.workspaceModel.exists({ slug })) {
      attempt += 1;
      slug = `${base}-${attempt}`;
    }

    const workspace = await this.workspaceModel.create({
      name: name.trim(),
      slug,
      ownerId: new Types.ObjectId(userId),
      isDefault,
    });

    const user = await this.usersService.getOrThrow(userId);
    await this.memberModel.create({
      workspaceId: workspace._id,
      userId: new Types.ObjectId(userId),
      email: user.email,
      role: WorkspaceRole.OWNER,
      status: WorkspaceMemberStatus.ACTIVE,
    });

    await this.brandsService.ensureDefaults(String(workspace._id));
    return workspace;
  }

  async listForUser(userId: string): Promise<Array<Record<string, unknown>>> {
    const memberships = await this.memberModel
      .find({
        userId: new Types.ObjectId(userId),
        status: WorkspaceMemberStatus.ACTIVE,
      })
      .lean()
      .exec();

    const ids = memberships.map((m) => m.workspaceId);
    const workspaces = await this.workspaceModel
      .find({ _id: { $in: ids } })
      .sort({ name: 1 })
      .lean()
      .exec();

    return workspaces.map((ws) => {
      const membership = memberships.find(
        (m) => String(m.workspaceId) === String(ws._id),
      );
      return {
        ...ws,
        role: membership?.role,
        membershipId: membership?._id,
      };
    });
  }

  async getActiveMembership(userId: string, workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) return null;
    return this.memberModel
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        userId: new Types.ObjectId(userId),
        status: WorkspaceMemberStatus.ACTIVE,
      })
      .exec();
  }

  async assertMember(userId: string, workspaceId: string) {
    const membership = await this.getActiveMembership(userId, workspaceId);
    if (!membership) {
      throw new ForbiddenException('You are not a member of this workspace');
    }
    return membership;
  }

  async getWorkspaceForMember(
    userId: string,
    workspaceId: string,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new BadRequestException('Invalid workspace ID');
    }
    await this.assertMember(userId, workspaceId);
    const workspace = await this.workspaceModel
      .findById(workspaceId)
      .lean()
      .exec();
    if (!workspace) throw new NotFoundException('Workspace not found');
    const membership = await this.getActiveMembership(userId, workspaceId);
    return { ...workspace, role: membership!.role };
  }

  /** Masked status only — configured/last4/updatedAt, never the plaintext. Any active member may check. */
  async getGithubTokenStatus(actorUserId: string, workspaceId: string) {
    await this.assertMember(actorUserId, workspaceId);
    const ws = await this.workspaceModel
      .findById(workspaceId)
      .select('githubTokenLast4 githubTokenUpdatedAt')
      .lean()
      .exec();
    if (!ws?.githubTokenLast4) return { configured: false as const };
    return {
      configured: true as const,
      last4: ws.githubTokenLast4,
      updatedAt: ws.githubTokenUpdatedAt,
    };
  }

  async setGithubToken(
    actorUserId: string,
    workspaceId: string,
    token: string,
  ) {
    await this.assertMember(actorUserId, workspaceId);
    const trimmed = token.trim();
    if (trimmed.length < 20 || trimmed.length > 255 || /\s/.test(trimmed)) {
      throw new BadRequestException(
        'That does not look like a valid GitHub token',
      );
    }
    const masterKey = this.config.get<string>('TOKEN_ENCRYPTION_KEY')?.trim();
    if (!masterKey) {
      throw new BadRequestException(
        'TOKEN_ENCRYPTION_KEY is not configured on the server — ask an administrator to set it before workspace GitHub tokens can be used.',
      );
    }

    const encrypted = encryptSecret(trimmed, masterKey);
    const updatedAt = new Date();
    await this.workspaceModel.updateOne(
      { _id: new Types.ObjectId(workspaceId) },
      {
        $set: {
          githubTokenCiphertext: encrypted.ciphertext,
          githubTokenIv: encrypted.iv,
          githubTokenAuthTag: encrypted.authTag,
          githubTokenLast4: maskToken(trimmed),
          githubTokenUpdatedAt: updatedAt,
        },
      },
    );
    this.tokenCache.delete(workspaceId);
    this.logger.log(`GitHub token updated for workspace ${workspaceId}`);
    return {
      configured: true as const,
      last4: maskToken(trimmed),
      updatedAt,
    };
  }

  async clearGithubToken(actorUserId: string, workspaceId: string) {
    await this.assertMember(actorUserId, workspaceId);
    await this.workspaceModel.updateOne(
      { _id: new Types.ObjectId(workspaceId) },
      {
        $unset: {
          githubTokenCiphertext: '',
          githubTokenIv: '',
          githubTokenAuthTag: '',
          githubTokenLast4: '',
          githubTokenUpdatedAt: '',
        },
      },
    );
    this.tokenCache.delete(workspaceId);
    this.logger.log(`GitHub token cleared for workspace ${workspaceId}`);
    return { configured: false as const };
  }

  /**
   * SERVER-INTERNAL ONLY. Returns the decrypted plaintext token in memory for
   * exactly one outbound GitHub call — never log it, never return it from a
   * controller, never persist it anywhere but the encrypted fields above.
   */
  async resolveGithubToken(workspaceId: string): Promise<string | undefined> {
    const cached = this.tokenCache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const ws = await this.workspaceModel
      .findById(workspaceId)
      .select('githubTokenCiphertext githubTokenIv githubTokenAuthTag')
      .lean()
      .exec();

    const remember = (token: string | undefined) => {
      this.tokenCache.set(workspaceId, {
        token,
        expiresAt: Date.now() + WorkspacesService.TOKEN_CACHE_TTL_MS,
      });
      return token;
    };

    if (
      !ws?.githubTokenCiphertext ||
      !ws.githubTokenIv ||
      !ws.githubTokenAuthTag
    ) {
      return remember(undefined);
    }

    const masterKey = this.config.get<string>('TOKEN_ENCRYPTION_KEY')?.trim();
    if (!masterKey) {
      this.logger.error(
        `Workspace ${workspaceId} has a GitHub token but TOKEN_ENCRYPTION_KEY is not set — cannot decrypt`,
      );
      return remember(undefined);
    }

    try {
      const token = decryptSecret(
        {
          ciphertext: ws.githubTokenCiphertext,
          iv: ws.githubTokenIv,
          authTag: ws.githubTokenAuthTag,
        },
        masterKey,
      );
      return remember(token);
    } catch (error) {
      this.logger.error(
        `Failed to decrypt GitHub token for workspace ${workspaceId}: ${(error as Error).message}`,
      );
      return remember(undefined);
    }
  }
}
