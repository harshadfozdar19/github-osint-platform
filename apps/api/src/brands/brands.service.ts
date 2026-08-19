import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  MonitoredBrand,
  MonitoredBrandDocument,
} from './schemas/monitored-brand.schema';
import { MONITORED_BRANDS } from '../common/enums';
import { CreateBrandDto, UpdateBrandFullDto } from './dto/create-brand.dto';

// Users often paste the org's GitHub URL (e.g. from their browser address bar)
// instead of the bare login the GitHub API expects - normalize so a pasted
// "https://github.com/angel-one" still resolves to owner "angel-one" rather
// than silently failing owner-format validation deep in the scan pipeline.
function normalizeGithubOwner(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)/i,
  );
  return match ? match[1] : trimmed;
}

function normalizeGithubOwners(owners: string[]): string[] {
  return owners
    .map((owner) => normalizeGithubOwner(owner))
    .filter((owner) => owner.length > 0);
}

@Injectable()
export class BrandsService {
  constructor(
    @InjectModel(MonitoredBrand.name)
    private readonly brandModel: Model<MonitoredBrandDocument>,
  ) {}

  async list(workspaceId: string) {
    await this.ensureDefaults(workspaceId);
    return this.brandModel
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ name: 1 })
      .lean()
      .exec();
  }

  async setEnabled(workspaceId: string, id: string, enabled: boolean) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Brand not found');
    }
    const brand = await this.brandModel
      .findOneAndUpdate(
        { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
        { enabled },
        { new: true },
      )
      .lean()
      .exec();
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async create(workspaceId: string, dto: CreateBrandDto) {
    const ws = new Types.ObjectId(workspaceId);
    return this.brandModel.create({
      workspaceId: ws,
      name: dto.name,
      description: dto.description || '',
      aliases: dto.aliases || [],
      keywords: dto.keywords || [],
      trustedGithubOwners: normalizeGithubOwners(dto.trustedGithubOwners || []),
      enabled: dto.enabled !== false,
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateBrandFullDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Brand not found');
    }
    const updateData: Partial<UpdateBrandFullDto> = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.aliases !== undefined) updateData.aliases = dto.aliases;
    if (dto.keywords !== undefined) updateData.keywords = dto.keywords;
    if (dto.trustedGithubOwners !== undefined) {
      updateData.trustedGithubOwners = normalizeGithubOwners(
        dto.trustedGithubOwners,
      );
    }
    if (dto.enabled !== undefined) updateData.enabled = dto.enabled;

    const brand = await this.brandModel
      .findOneAndUpdate(
        { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
        { $set: updateData },
        { new: true },
      )
      .lean()
      .exec();
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async remove(workspaceId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Brand not found');
    }
    const deleted = await this.brandModel
      .findOneAndDelete({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!deleted) throw new NotFoundException('Brand not found');
    return { success: true };
  }

  async ensureDefaults(workspaceId: string) {
    const ws = new Types.ObjectId(workspaceId);
    const count = await this.brandModel
      .countDocuments({ workspaceId: ws })
      .exec();
    if (count > 0) return;
    for (const brand of MONITORED_BRANDS) {
      await this.brandModel.updateOne(
        { workspaceId: ws, name: brand.name },
        {
          $setOnInsert: {
            workspaceId: ws,
            name: brand.name,
            description: '',
            aliases: [...brand.aliases],
            keywords: [...brand.keywords],
            enabled: true,
          },
        },
        { upsert: true },
      );
    }
  }
}
