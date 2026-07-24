/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { KeywordsController } from './keywords.controller';
import { KeywordsService } from './keywords.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../tenancy/tenant.guard';

describe('KeywordsController', () => {
  let app: INestApplication;
  const workspaceId = 'ws-keywords-test';
  const keywords: Array<Record<string, unknown>> = [];

  const keywordsService = {
    list: jest.fn(async (ws: string) =>
      keywords.filter((k) => k.workspaceId === ws),
    ),
    create: jest.fn(async (ws: string, dto: Record<string, unknown>) => {
      const row = {
        _id: `kw-${keywords.length + 1}`,
        workspaceId: ws,
        keyword: String(dto.keyword).toLowerCase(),
        category: dto.category || 'general',
        priority: dto.priority ?? 5,
        enabled: dto.enabled !== false,
      };
      keywords.push(row);
      return row;
    }),
    update: jest.fn(
      async (ws: string, id: string, dto: Record<string, unknown>) => {
        const row = keywords.find((k) => k._id === id && k.workspaceId === ws);
        if (!row) throw new Error('not found');
        Object.assign(row, dto);
        return row;
      },
    ),
    remove: jest.fn(async (ws: string, id: string) => {
      const idx = keywords.findIndex(
        (k) => k._id === id && k.workspaceId === ws,
      );
      if (idx < 0) throw new Error('not found');
      keywords.splice(idx, 1);
      return { success: true };
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [KeywordsController],
      providers: [{ provide: KeywordsService, useValue: keywordsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().user = {
            id: 'user1',
            email: 'a@b.com',
          };
          return true;
        },
      })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().tenant = {
            workspaceId,
            role: 'owner',
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    keywords.length = 0;
    jest.clearAllMocks();
  });

  it('lists keywords', async () => {
    keywords.push({
      _id: 'kw-1',
      workspaceId,
      keyword: 'wallet',
      category: 'phishing',
      priority: 8,
      enabled: true,
    });
    const res = await request(app.getHttpServer()).get('/keywords').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].keyword).toBe('wallet');
  });

  it('creates a keyword', async () => {
    const res = await request(app.getHttpServer())
      .post('/keywords')
      .send({ keyword: 'otp', category: 'phishing', priority: 9 })
      .expect(201);
    expect(res.body.keyword).toBe('otp');
    expect(keywordsService.create).toHaveBeenCalled();
  });

  it('updates and deletes a keyword', async () => {
    keywords.push({
      _id: 'kw-1',
      workspaceId,
      keyword: 'wallet',
      category: 'phishing',
      priority: 5,
      enabled: true,
    });

    await request(app.getHttpServer())
      .patch('/keywords/kw-1')
      .send({ enabled: false })
      .expect(200);

    await request(app.getHttpServer()).delete('/keywords/kw-1').expect(200);
    expect(keywords).toHaveLength(0);
  });
});
