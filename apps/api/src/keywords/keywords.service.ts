import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Keyword, KeywordDocument } from './schemas/keyword.schema';
import { CreateKeywordDto, UpdateKeywordDto } from './dto/create-keyword.dto';

export const DEFAULT_SEEDED_KEYWORDS = [
  { keyword: 'paypal', category: 'brand', priority: 8 },
  { keyword: 'google', category: 'brand', priority: 8 },
  { keyword: 'amazon', category: 'brand', priority: 8 },
  { keyword: 'login', category: 'phishing', priority: 7 },
  { keyword: 'credential', category: 'phishing', priority: 9 },
  { keyword: 'otp', category: 'phishing', priority: 8 },
  { keyword: 'bank', category: 'phishing', priority: 7 },
  { keyword: 'wallet', category: 'phishing', priority: 7 },
  { keyword: 'crypto', category: 'malware', priority: 6 },
  { keyword: 'verification', category: 'phishing', priority: 7 },
  { keyword: 'payment', category: 'phishing', priority: 7 },
  { keyword: 'aws', category: 'secret', priority: 9 },
  { keyword: 'firebase', category: 'secret', priority: 9 },
  { keyword: 'secret', category: 'secret', priority: 9 },
  { keyword: 'apikey', category: 'secret', priority: 9 },
  { keyword: 'token', category: 'secret', priority: 8 },
  { keyword: 'kyc', category: 'phishing', priority: 7 },
  { keyword: 'trading', category: 'phishing', priority: 6 },
  { keyword: 'support', category: 'phishing', priority: 6 },
  { keyword: 'apk', category: 'malware', priority: 8 },
  { keyword: 'mod', category: 'malware', priority: 5 },
  { keyword: 'cracked', category: 'malware', priority: 6 },
  { keyword: 'phishing', category: 'phishing', priority: 9 },
  { keyword: 'clone', category: 'phishing', priority: 7 },
  { keyword: 'bypass', category: 'phishing', priority: 8 },
  { keyword: 'free money', category: 'phishing', priority: 6 },
  { keyword: 'gift card', category: 'phishing', priority: 6 },
  { keyword: '2fa bypass', category: 'phishing', priority: 9 },
];

@Injectable()
export class KeywordsService {
  constructor(
    @InjectModel(Keyword.name)
    private readonly keywordModel: Model<KeywordDocument>,
  ) {}

  async list(workspaceId: string) {
    await this.ensureDefaults(workspaceId);
    return this.keywordModel
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ keyword: 1 })
      .lean()
      .exec();
  }

  async create(workspaceId: string, dto: CreateKeywordDto) {
    const ws = new Types.ObjectId(workspaceId);
    const exists = await this.keywordModel
      .findOne({ workspaceId: ws, keyword: dto.keyword.trim().toLowerCase() })
      .exec();
    if (exists) {
      throw new ConflictException('Keyword already exists in this workspace');
    }
    return this.keywordModel.create({
      workspaceId: ws,
      keyword: dto.keyword.trim().toLowerCase(),
      category: dto.category || 'general',
      priority: dto.priority ?? 5,
      enabled: dto.enabled !== false,
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateKeywordDto) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Keyword not found');
    }
    const updateData: Record<string, any> = {};
    if (dto.keyword !== undefined)
      updateData.keyword = dto.keyword.trim().toLowerCase();
    if (dto.category !== undefined) updateData.category = dto.category;
    if (dto.priority !== undefined) updateData.priority = dto.priority;
    if (dto.enabled !== undefined) updateData.enabled = dto.enabled;

    const updated = await this.keywordModel
      .findOneAndUpdate(
        { _id: id, workspaceId: new Types.ObjectId(workspaceId) },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException('Keyword not found');
    }
    return updated;
  }

  async remove(workspaceId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Keyword not found');
    }
    const deleted = await this.keywordModel
      .findOneAndDelete({
        _id: id,
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .exec();

    if (!deleted) {
      throw new NotFoundException('Keyword not found');
    }
    return { success: true };
  }

  async ensureDefaults(workspaceId: string) {
    const ws = new Types.ObjectId(workspaceId);
    const count = await this.keywordModel
      .countDocuments({ workspaceId: ws })
      .exec();
    if (count > 0) return;

    const docs = DEFAULT_SEEDED_KEYWORDS.map((k) => ({
      workspaceId: ws,
      keyword: k.keyword,
      category: k.category,
      priority: k.priority,
      enabled: true,
    }));
    await this.keywordModel.insertMany(docs);
  }
}
