import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { env } from '../../config/env';

interface JwtPayload {
  userId: string;
  email?: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.JWT_SECRET,
    });
  }

  async validate(payload: JwtPayload) {
    if (!payload || typeof payload.userId !== 'string' || payload.userId.length === 0) {
      throw new UnauthorizedException('Token 无效或已过期');
    }
    if (
      payload.email !== undefined &&
      payload.email !== null &&
      typeof payload.email !== 'string'
    ) {
      throw new UnauthorizedException('Token 无效或已过期');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Token 无效或已过期');
    }

    return user; // 注入到 request.user
  }
}
