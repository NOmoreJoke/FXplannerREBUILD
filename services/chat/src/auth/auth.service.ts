import {
  Inject,
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import type { RegisterDto, LoginDto, AuthResponseDto, UserDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private prisma: PrismaService,
    @Inject(JwtService) private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const email = this.normalizeEmail(dto.email);

    // 1. 检查邮箱是否已存在
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException('该邮箱已被注册');
    }

    // 2. 加密密码
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    // 3. 创建用户
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    // 4. 生成 JWT Token
    const accessToken = this.generateToken(user.id, user.email);

    // 5. 返回用户信息和 Token
    return {
      user: this.toUserDto(user),
      accessToken,
    };
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const email = this.normalizeEmail(dto.email);

    // 1. 查询用户
    const user = await this.prisma.user.findUnique({
      where: { email },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 2. 验证密码
    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 3. 生成 JWT Token
    const accessToken = this.generateToken(user.id, user.email);

    // 4. 返回用户信息和 Token
    return {
      user: this.toUserDto(user),
      accessToken,
    };
  }

  async loginWithOtp(verification: {
    channel: string;
    target: string;
  }): Promise<AuthResponseDto> {
    const findIdentity = () =>
      this.prisma.otpIdentity.findUnique({
        where: {
          channel_target: {
            channel: verification.channel,
            target: verification.target,
          },
        },
        include: { user: true },
      });

    let identity = await findIdentity();
    let user = identity?.user;

    if (!user) {
      try {
        user = await this.prisma.$transaction(async (tx) => {
          const existing = await tx.otpIdentity.findUnique({
            where: {
              channel_target: {
                channel: verification.channel,
                target: verification.target,
              },
            },
            include: { user: true },
          });
          if (existing) return existing.user;

          const created = await tx.user.create({ data: {} });
          await tx.otpIdentity.create({
            data: {
              userId: created.id,
              channel: verification.channel,
              target: verification.target,
            },
          });
          return created;
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') {
          throw error;
        }
        identity = await findIdentity();
        user = identity?.user;
      }
    }

    if (!user) {
      throw new ConflictException('OTP 账号创建失败');
    }

    return {
      user: this.toUserDto(user),
      accessToken: this.generateToken(user.id, user.email),
      identity: {
        channel: verification.channel,
        target: verification.target,
      },
    };
  }

  async getMe(userId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    return this.toUserDto(user);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private generateToken(userId: string, email: string | null): string {
    const payload = { userId, email };
    return this.jwtService.sign(payload);
  }

  private toUserDto(user: any): UserDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      createdAt: user.createdAt,
    };
  }
}
