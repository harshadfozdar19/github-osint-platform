import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.usersService.create({
      email: dto.email.toLowerCase(),
      name: dto.name.trim(),
      passwordHash,
    });

    const userId = user.id as string;
    const workspace = await this.workspacesService.createForUser(
      userId,
      `${user.name}'s Workspace`,
      true,
    );

    return this.buildAuthResponse(
      userId,
      user.email,
      user.name,
      String(workspace._id),
    );
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const userId = user.id as string;
    const workspaces = await this.workspacesService.listForUser(userId);
    let defaultWorkspaceId = workspaces[0]
      ? String(workspaces[0]._id)
      : undefined;
    if (!defaultWorkspaceId) {
      const workspace = await this.workspacesService.createForUser(
        userId,
        `${user.name}'s Workspace`,
        true,
      );
      defaultWorkspaceId = String(workspace._id);
    }

    return this.buildAuthResponse(
      userId,
      user.email,
      user.name,
      defaultWorkspaceId,
    );
  }

  async me(userId: string): Promise<{
    id: string;
    email: string;
    name: string;
    createdAt: Date;
    workspaces: Array<Record<string, unknown>>;
  }> {
    const user = await this.usersService.getOrThrow(userId);
    const workspaces = await this.workspacesService.listForUser(userId);
    return {
      id: user.id as string,
      email: user.email,
      name: user.name,
      createdAt: (user as unknown as { createdAt: Date }).createdAt,
      workspaces,
    };
  }

  private buildAuthResponse(
    id: string,
    email: string,
    name: string,
    defaultWorkspaceId?: string,
  ) {
    const accessToken = this.jwtService.sign({ sub: id, email });
    return {
      accessToken,
      tokenType: 'Bearer',
      user: { id, email, name },
      defaultWorkspaceId,
    };
  }
}
