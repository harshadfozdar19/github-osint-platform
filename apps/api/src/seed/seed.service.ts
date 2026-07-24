import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { BrandsService } from '../brands/brands.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  Repository,
  RepositoryDocument,
} from '../repositories/schemas/repository.schema';
import { Finding, FindingDocument } from '../findings/schemas/finding.schema';
import {
  Detection,
  DetectionDocument,
} from '../detections/schemas/detection.schema';
import { Alert, AlertDocument } from '../alerts/schemas/alert.schema';
import { Severity } from '../common/enums';
import { DetectionEngine } from '../detection/detection.engine';
import { RiskScoringService } from '../detection/risk-scoring.service';
import { RepoAnalysisContext } from '../detection/rules/rule.types';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly brandsService: BrandsService,
    private readonly workspacesService: WorkspacesService,
    private readonly detectionEngine: DetectionEngine,
    private readonly riskScoring: RiskScoringService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Repository.name)
    private readonly repoModel: Model<RepositoryDocument>,
    @InjectModel(Finding.name)
    private readonly findingModel: Model<FindingDocument>,
    @InjectModel(Detection.name)
    private readonly detectionModel: Model<DetectionDocument>,
    @InjectModel(Alert.name) private readonly alertModel: Model<AlertDocument>,
  ) {}

  async onModuleInit() {
    if (this.config.get('SEED_ON_BOOT') === 'true') {
      await this.seedDemoData();
    }
  }

  async seedDemoData() {
    const email = this.config.get<string>('SEED_DEMO_EMAIL');
    const password = this.config.get<string>('SEED_DEMO_PASSWORD');
    if (!email || !password) {
      this.logger.warn(
        'SEED_ON_BOOT is true but SEED_DEMO_EMAIL / SEED_DEMO_PASSWORD are not set — skipping demo seed. Set both in your local .env (never commit real values).',
      );
      return;
    }

    this.logger.log('Seeding demo data (clearly labeled DEMO)...');

    let user = await this.userModel.findOne({ email });
    if (!user) {
      user = await this.userModel.create({
        email,
        name: 'Demo Analyst',
        passwordHash: await bcrypt.hash(password, 12),
      });
    }

    const userId = String(user._id);
    let workspaces = await this.workspacesService.listForUser(userId);
    if (workspaces.length === 0) {
      await this.workspacesService.createForUser(
        userId,
        'Demo Workspace',
        true,
      );
      workspaces = await this.workspacesService.listForUser(userId);
    }

    const workspaceId = String(workspaces[0]._id);
    const ws = new Types.ObjectId(workspaceId);

    await this.brandsService.ensureDefaults(workspaceId);

    const brands = await this.brandsService.list(workspaceId);
    const phonepe = brands.find((b) => b.name === 'PhonePe');
    const zerodha = brands.find((b) => b.name === 'Zerodha');

    const demos: Array<{
      repo: Partial<Repository>;
      brandName?: string;
      brandId?: unknown;
      ctx: RepoAnalysisContext;
    }> = [
      {
        repo: {
          workspaceId: ws,
          githubId: 9000001,
          fullName: 'demo-threat/phonepe-login-apk',
          url: 'https://github.com/demo-threat/phonepe-login-apk',
          owner: 'demo-threat',
          name: 'phonepe-login-apk',
          description:
            'PhonePe login verification APK mod cracked wallet KYC bypass',
          language: 'Java',
          topics: ['apk', 'phonepe', 'mod'],
          stars: 0,
          forks: 0,
          isFork: false,
          githubCreatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          githubPushedAt: new Date(),
          lastScannedAt: new Date(),
          isDemo: true,
        },
        brandName: phonepe?.name,
        brandId: phonepe?._id,
        ctx: {
          fullName: 'demo-threat/phonepe-login-apk',
          owner: 'demo-threat',
          name: 'phonepe-login-apk',
          description:
            'PhonePe login verification APK mod cracked wallet KYC bypass',
          topics: ['apk', 'phonepe', 'mod'],
          language: 'Java',
          stars: 0,
          forks: 0,
          isFork: false,
          githubCreatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          filePaths: ['app-release.apk', 'README.md', 'config.env'],
          readmeText:
            'Fake PhonePe APK phishing kit. Login page clone for OTP harvest.\nAWS_KEY=AKIAIOSFODNN7EXAMPLE\nGITHUB_TOKEN=ghp_demotokenvalue0000000000000000000001',
          smallFileTexts: [
            {
              path: 'config.env',
              content:
                'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nMONGODB_URI=mongodb+srv://user:secretpass@cluster.mongodb.net/db',
            },
          ],
          matchedBrandName: 'PhonePe',
          matchedBrandAliases: ['phonepe'],
        },
      },
      {
        repo: {
          workspaceId: ws,
          githubId: 9000002,
          fullName: 'demo-threat/zerodha-kite-phishing',
          url: 'https://github.com/demo-threat/zerodha-kite-phishing',
          owner: 'demo-threat',
          name: 'zerodha-kite-phishing',
          description:
            'Zerodha kite trading login phishing page clone support verification',
          language: 'HTML',
          topics: ['phishing', 'zerodha'],
          stars: 1,
          forks: 0,
          isFork: false,
          githubCreatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          githubPushedAt: new Date(),
          lastScannedAt: new Date(),
          isDemo: true,
        },
        brandName: zerodha?.name,
        brandId: zerodha?._id,
        ctx: {
          fullName: 'demo-threat/zerodha-kite-phishing',
          owner: 'demo-threat',
          name: 'zerodha-kite-phishing',
          description:
            'Zerodha kite trading login phishing page clone support verification',
          topics: ['phishing', 'zerodha'],
          language: 'HTML',
          stars: 1,
          forks: 0,
          isFork: false,
          githubCreatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          filePaths: ['index.html', 'login.html', 'README.md'],
          readmeText: 'Phishing kit for Zerodha Kite login verification page.',
          smallFileTexts: [],
          matchedBrandName: 'Zerodha',
          matchedBrandAliases: ['zerodha', 'kite'],
        },
      },
    ];

    for (const demo of demos) {
      const repo = await this.repoModel.findOneAndUpdate(
        { workspaceId: ws, githubId: demo.repo.githubId },
        demo.repo,
        { upsert: true, new: true },
      );

      const detections = this.detectionEngine.analyze(demo.ctx);
      const risk = this.riskScoring.calculate(detections, demo.ctx);
      const fingerprint = `demo-${demo.repo.githubId}`;

      let finding = await this.findingModel.findOne({
        workspaceId: ws,
        repositoryId: repo._id,
        fingerprint,
      });
      if (!finding) {
        finding = await this.findingModel.create({
          workspaceId: ws,
          repositoryId: repo._id,
          brandId: demo.brandId,
          brandName: demo.brandName,
          fingerprint,
          severity: risk.severity,
          riskScore: risk.score,
          categories: [...new Set(detections.map((d) => d.category))],
          riskBreakdown: risk.breakdown,
          summary: `[DEMO] ${risk.severity.toUpperCase()} finding for ${demo.repo.fullName}`,
          isDemo: true,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        });
      } else {
        finding.severity = risk.severity;
        finding.riskScore = risk.score;
        finding.riskBreakdown = risk.breakdown;
        finding.categories = [...new Set(detections.map((d) => d.category))];
        finding.summary = `[DEMO] ${risk.severity.toUpperCase()} finding for ${demo.repo.fullName}`;
        await finding.save();
      }

      await this.detectionModel.deleteMany({
        findingId: finding._id,
        workspaceId: ws,
      });
      await this.detectionModel.insertMany(
        detections.map((d) => ({
          workspaceId: ws,
          findingId: finding._id,
          ...d,
        })),
      );

      if (
        risk.severity === Severity.CRITICAL ||
        risk.severity === Severity.HIGH
      ) {
        const exists = await this.alertModel.findOne({
          findingId: finding._id,
          workspaceId: ws,
        });
        if (!exists) {
          await this.alertModel.create({
            workspaceId: ws,
            findingId: finding._id,
            severity: risk.severity,
            title: `[DEMO] ${risk.severity.toUpperCase()} risk detected`,
            message: finding.summary,
            read: false,
            channel: 'in_app',
          });
        }
      }
    }

    this.logger.log(`Demo user: ${email} / ${password}`);
    this.logger.log(`Demo workspaceId: ${workspaceId}`);
    this.logger.log('Demo findings seeded.');
  }
}
