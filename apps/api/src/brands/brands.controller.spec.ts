/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../tenancy/tenant.guard';

describe('BrandsController', () => {
  let app: INestApplication;
  const workspaceId = 'ws-brands-test';
  const brands: Array<Record<string, unknown>> = [];

  const brandsService = {
    list: jest.fn(async (ws: string) =>
      brands.filter((b) => b.workspaceId === ws),
    ),
    create: jest.fn(async (ws: string, dto: Record<string, unknown>) => {
      const row = {
        _id: `brand-${brands.length + 1}`,
        workspaceId: ws,
        name: dto.name,
        description: dto.description || '',
        aliases: dto.aliases || [],
        keywords: dto.keywords || [],
        enabled: dto.enabled !== false,
      };
      brands.push(row);
      return row;
    }),
    update: jest.fn(
      async (ws: string, id: string, dto: Record<string, unknown>) => {
        const row = brands.find((b) => b._id === id && b.workspaceId === ws);
        if (!row) throw new Error('not found');
        Object.assign(row, dto);
        return row;
      },
    ),
    remove: jest.fn(async (ws: string, id: string) => {
      const idx = brands.findIndex((b) => b._id === id && b.workspaceId === ws);
      if (idx < 0) throw new Error('not found');
      brands.splice(idx, 1);
      return { success: true };
    }),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BrandsController],
      providers: [{ provide: BrandsService, useValue: brandsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().user = { id: 'user1' };
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
    brands.length = 0;
    jest.clearAllMocks();
  });

  it('lists brands on /brands and /companies', async () => {
    brands.push({
      _id: 'brand-1',
      workspaceId,
      name: 'PhonePe',
      aliases: ['phonepe'],
      keywords: ['phonepe'],
      enabled: true,
    });

    const brandsRes = await request(app.getHttpServer())
      .get('/brands')
      .expect(200);
    expect(brandsRes.body[0].name).toBe('PhonePe');

    const companiesRes = await request(app.getHttpServer())
      .get('/companies')
      .expect(200);
    expect(companiesRes.body[0].name).toBe('PhonePe');
  });

  it('creates and deletes a company', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/companies')
      .send({ name: 'FYND', aliases: ['fynd'], keywords: ['fynd'] })
      .expect(201);
    expect(createRes.body.name).toBe('FYND');

    await request(app.getHttpServer())
      .delete(`/companies/${createRes.body._id}`)
      .expect(200);
    expect(brands).toHaveLength(0);
  });
});
