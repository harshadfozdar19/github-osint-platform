import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Finding, FindingDocument } from './schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { FindingStatus, Severity, ThreatCategory } from '../common/enums';
import { UpdateFindingStatusDto } from './dto/update-finding-status.dto';

export interface FindingFilters {
  workspaceId: string;
  search?: string;
  severity?: Severity;
  category?: ThreatCategory;
  brand?: string;
  status?: FindingStatus;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class FindingsService {
  constructor(
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
  ) {}

  async list(filters: FindingFilters) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;
    const workspaceId = new Types.ObjectId(filters.workspaceId);

    const query: FilterQuery<FindingDocument> = { workspaceId };
    if (filters.severity) query.severity = filters.severity;
    if (filters.category) query.categories = filters.category;
    if (filters.status) query.status = filters.status;
    if (filters.brand) query.brandName = new RegExp(filters.brand, 'i');
    if (filters.from || filters.to) {
      query.createdAt = {};
      if (filters.from)
        (query.createdAt as Record<string, Date>).$gte = filters.from;
      if (filters.to)
        (query.createdAt as Record<string, Date>).$lte = filters.to;
    }
    if (filters.search) {
      query.$or = [
        { summary: new RegExp(filters.search, 'i') },
        { brandName: new RegExp(filters.search, 'i') },
      ];
    }

    const allowedSort = new Set([
      'createdAt',
      'riskScore',
      'severity',
      'lastSeenAt',
      'status',
    ]);
    const sortBy = allowedSort.has(filters.sortBy || '')
      ? filters.sortBy!
      : 'createdAt';
    const sortOrder = filters.sortOrder === 'asc' ? 1 : -1;

    const [data, total] = await Promise.all([
      this.findingModel
        .find(query)
        .sort({ [sortBy]: sortOrder })
        .skip(skip)
        .limit(limit)
        .populate('repositoryId')
        .lean()
        .exec(),
      this.findingModel.countDocuments(query).exec(),
    ]);

    return { data, total, page, limit };
  }

  async getById(
    workspaceId: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Finding not found');
    }

    const finding = await this.findingModel
      .findOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .populate('repositoryId')
      .lean()
      .exec();
    if (!finding) throw new NotFoundException('Finding not found');

    const detections = await this.detectionModel
      .find({
        // Must be explicitly cast: unlike the `_id` filter above, Mongoose
        // does not reliably auto-cast a plain string for a regular
        // ObjectId-typed field, so an uncast string here silently matches
        // nothing even when matching detections exist.
        findingId: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .lean()
      .exec();
    return { ...finding, detections };
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    userId: string,
    dto: UpdateFindingStatusDto,
  ): Promise<Record<string, unknown>> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Finding not found');
    }
    if (!Object.values(FindingStatus).includes(dto.status)) {
      throw new BadRequestException('Invalid finding status');
    }

    const finding = await this.findingModel
      .findOne({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();
    if (!finding) throw new NotFoundException('Finding not found');

    finding.status = dto.status;
    finding.triageNote = (dto.note || '').trim();
    finding.triagedBy = new Types.ObjectId(userId);
    finding.triagedAt = new Date();

    if (
      dto.status === FindingStatus.RESOLVED ||
      dto.status === FindingStatus.FALSE_POSITIVE
    ) {
      finding.resolvedAt = new Date();
    } else if (
      dto.status === FindingStatus.OPEN ||
      dto.status === FindingStatus.ACKNOWLEDGED
    ) {
      finding.resolvedAt = undefined;
    }

    await finding.save();
    return this.getById(workspaceId, id);
  }
}
