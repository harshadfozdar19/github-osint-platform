/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { JwtStrategy } from './jwt.strategy';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

describe('AuthController (unit/integration light)', () => {
  let app: INestApplication;
  const users: Array<{
    id: string;
    email: string;
    name: string;
    passwordHash: string;
  }> = [];

  const usersService = {
    findByEmail: (email: string) =>
      Promise.resolve(users.find((u) => u.email === email) || null),
    create: (data: { email: string; name: string; passwordHash: string }) => {
      const user = { id: 'user1', ...data };
      users.push(user);
      return Promise.resolve(user);
    },
    findById: (id: string) =>
      Promise.resolve(users.find((u) => u.id === id) || null),
    getOrThrow: (id: string) => {
      const u = users.find((x) => x.id === id);
      if (!u) return Promise.reject(new Error('not found'));
      return Promise.resolve({ ...u, createdAt: new Date() });
    },
  };

  const workspacesService = {
    activateInvitesForUser: jest.fn().mockResolvedValue(undefined),
    createForUser: jest.fn().mockResolvedValue({ _id: 'ws1' }),
    listForUser: jest.fn().mockResolvedValue([{ _id: 'ws1', name: 'Demo' }]),
  };

  beforeAll(async () => {
    users.length = 0;
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: WorkspacesService, useValue: workspacesService },
        {
          provide: JwtService,
          useValue: {
            sign: (payload: object) => `token-${JSON.stringify(payload)}`,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: () => 'test-secret-at-least-32-characters-long',
          },
        },
        {
          provide: JwtStrategy,
          useValue: {},
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'analyst@example.com',
        name: 'Analyst',
        password: 'ChangeMe123!',
      })
      .expect(201);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.email).toBe('analyst@example.com');
    expect(res.body.defaultWorkspaceId).toBe('ws1');
    expect(workspacesService.createForUser).toHaveBeenCalled();
  });

  it('rejects duplicate registration', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'analyst@example.com',
        name: 'Analyst',
        password: 'ChangeMe123!',
      })
      .expect(409);
  });

  it('logs in with valid credentials', async () => {
    const hash = await bcrypt.hash('ChangeMe123!', 4);
    users[0].passwordHash = hash;

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'analyst@example.com', password: 'ChangeMe123!' })
      .expect(201);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.defaultWorkspaceId).toBeDefined();
  });

  it('rejects invalid login', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'analyst@example.com', password: 'wrong-password' })
      .expect(401);
  });
});
