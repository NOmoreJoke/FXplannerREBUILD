import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type { OtpChannel, OtpChannelType } from "./otp-channel";
import { OTP_CHANNELS, OTP_OPTIONS } from "./otp-channel";
import type { SendOtpCodeDto } from "./dto/send-otp-code.dto";
import type { OtpLoginDto } from "./dto/otp-login.dto";

/** 验证码有效期：10 分钟（doc 01 验证码规则，技术方案 §5） */
export const OTP_EXPIRY_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_TARGET_WINDOW_MS = 60 * 1000;
export const OTP_IP_WINDOW_MS = 60 * 1000;
export const OTP_TARGET_MAX_REQUESTS = 1;
export const OTP_IP_MAX_REQUESTS = 5;

/** 发送上限窗口：1 小时 / 24 小时（doc 01：1h 最多 5 次、24h 最多 20 次） */
export const OTP_SEND_WINDOW_1H_MS = 60 * 60 * 1000;
export const OTP_SEND_WINDOW_24H_MS = 24 * 60 * 60 * 1000;
export const OTP_SEND_MAX_PER_HOUR = 5;
export const OTP_SEND_MAX_PER_DAY = 20;

/** 输错锁定：同一邮箱 15 分钟窗口内累计失败尝试 ≥5 次 → 全部失效并暂停验证与发送（doc 01） */
export const OTP_VERIFY_LOCK_WINDOW_MS = 15 * 60 * 1000;
export const OTP_VERIFY_LOCK_THRESHOLD = 5;

export interface OtpServiceOptions {
  now?: () => Date;
  expiryMs?: number;
  maxAttempts?: number;
  targetWindowMs?: number;
  ipWindowMs?: number;
  targetMaxRequests?: number;
  ipMaxRequests?: number;
  sendWindow1hMs?: number;
  sendWindow24hMs?: number;
  sendMaxPerHour?: number;
  sendMaxPerDay?: number;
  verifyLockWindowMs?: number;
  verifyLockThreshold?: number;
  codeSecret?: string;
}

export interface OtpChallengeResult {
  challengeId: string;
  expiresAt: Date;
  /** [dev] mock 渠道（devMode=true）时附带验证码明文，供本地联调/E2E；真实渠道恒为 undefined */
  devCode?: string;
}

export interface OtpVerificationResult {
  verified: true;
  challengeId: string;
  channel: OtpChannelType;
  target: string;
}

type OtpChallengeRecord = {
  id: string;
  channel: string;
  target: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
};

type OtpChallengeDelegate = {
  create(args: {
    data: {
      channel: string;
      target: string;
      codeHash: string;
      expiresAt: Date;
      requestIp: string;
    };
    select: { id: true; expiresAt: true };
  }): Promise<{ id: string; expiresAt: Date }>;
  delete(args: { where: { id: string } }): Promise<unknown>;
  findUnique(args: { where: { id: string } }): Promise<OtpChallengeRecord | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  aggregate(args: {
    where: Record<string, unknown>;
    _sum: { attempts: true };
  }): Promise<{ _sum: { attempts: number | null } }>;
};

class OtpTooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** 发送上限（1h ≥5 或 24h ≥20，按目标邮箱统计已创建验证码条数） */
class OtpSendRateLimitedException extends HttpException {
  constructor() {
    super(
      {
        code: "OTP_SEND_RATE_LIMITED",
        message: "验证码发送过于频繁：1 小时内最多发送 5 次、24 小时内最多发送 20 次，请稍后再试",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** 输错锁定（15 分钟窗口累计失败尝试 ≥5：全部未消费验证码作废 + 暂停验证与发送） */
class OtpVerifyLockedException extends HttpException {
  constructor() {
    super(
      {
        code: "OTP_VERIFY_LOCKED",
        message: "验证码错误次数过多，该邮箱的验证码已全部失效，请 15 分钟后重新获取",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export function normalizeOtpTarget(channel: OtpChannelType, target: string): string {
  const value = target.trim();
  if (channel === "email") {
    const normalized = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BadRequestException("邮箱格式不正确");
    }
    return normalized;
  }

  const normalized = value.replace(/[\s()-]/g, "").replace(/^00/, "+");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new BadRequestException("手机号必须使用 E.164 格式");
  }
  return normalized;
}

function normalizeRequestIp(requestIp: string): string {
  const normalized = requestIp.trim();
  if (!normalized) {
    throw new BadRequestException("requestIp 不能为空");
  }
  return normalized;
}

function hashCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

@Injectable()
export class OtpService {
  private readonly now: () => Date;
  private readonly expiryMs: number;
  private readonly maxAttempts: number;
  private readonly targetWindowMs: number;
  private readonly ipWindowMs: number;
  private readonly targetMaxRequests: number;
  private readonly ipMaxRequests: number;
  private readonly sendWindow1hMs: number;
  private readonly sendWindow24hMs: number;
  private readonly sendMaxPerHour: number;
  private readonly sendMaxPerDay: number;
  private readonly verifyLockWindowMs: number;
  private readonly verifyLockThreshold: number;
  private readonly codeSecret: string;
  private readonly otpChallenge: OtpChallengeDelegate;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OTP_CHANNELS) @Optional() private readonly channels: OtpChannel[] = [],
    @Inject(OTP_OPTIONS) @Optional() options: OtpServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.expiryMs = options.expiryMs ?? OTP_EXPIRY_MS;
    this.maxAttempts = options.maxAttempts ?? OTP_MAX_ATTEMPTS;
    this.targetWindowMs = options.targetWindowMs ?? OTP_TARGET_WINDOW_MS;
    this.ipWindowMs = options.ipWindowMs ?? OTP_IP_WINDOW_MS;
    this.targetMaxRequests = options.targetMaxRequests ?? OTP_TARGET_MAX_REQUESTS;
    this.ipMaxRequests = options.ipMaxRequests ?? OTP_IP_MAX_REQUESTS;
    this.sendWindow1hMs = options.sendWindow1hMs ?? OTP_SEND_WINDOW_1H_MS;
    this.sendWindow24hMs = options.sendWindow24hMs ?? OTP_SEND_WINDOW_24H_MS;
    this.sendMaxPerHour = options.sendMaxPerHour ?? OTP_SEND_MAX_PER_HOUR;
    this.sendMaxPerDay = options.sendMaxPerDay ?? OTP_SEND_MAX_PER_DAY;
    this.verifyLockWindowMs = options.verifyLockWindowMs ?? OTP_VERIFY_LOCK_WINDOW_MS;
    this.verifyLockThreshold = options.verifyLockThreshold ?? OTP_VERIFY_LOCK_THRESHOLD;
    const codeSecret = options.codeSecret ?? process.env.OTP_CODE_SECRET;
    if (!codeSecret) {
      throw new Error("必须配置独立的 OTP_CODE_SECRET");
    }
    this.codeSecret = codeSecret;
    this.otpChallenge = (this.prisma as unknown as { otpChallenge: OtpChallengeDelegate }).otpChallenge;
  }

  async sendCode(dto: SendOtpCodeDto, requestIp: string): Promise<OtpChallengeResult> {
    const channel = this.getChannel(dto.channel);
    const target = normalizeOtpTarget(dto.channel, dto.target);
    const normalizedIp = normalizeRequestIp(requestIp);
    const now = this.now();

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const expiresAt = new Date(now.getTime() + this.expiryMs);
    const challenge = await this.prisma.$transaction(async (tx) => {
      const lockKeys = [
        `otp:target:${dto.channel}:${target}`,
        `otp:ip:${normalizedIp}`,
      ].sort();
      for (const lockKey of lockKeys) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }

      await this.assertRateLimit(tx.otpChallenge, dto.channel, target, normalizedIp, now);

      // 新验证码发出后，同一目标尚未使用的旧验证码立即失效。
      await tx.otpChallenge.updateMany({
        where: {
          channel: dto.channel,
          target,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });

      return tx.otpChallenge.create({
        data: {
          channel: dto.channel,
          target,
          codeHash: hashCode(code, this.codeSecret),
          expiresAt,
          requestIp: normalizedIp,
        },
        select: { id: true, expiresAt: true },
      });
    });

    try {
      await channel.send(target, code);
    } catch (error) {
      await this.otpChallenge.delete({ where: { id: challenge.id } }).catch(() => undefined);
      throw error;
    }

    // mock 渠道（未接入真实邮件服务）把验证码随响应带回，本地演示与 E2E 依赖它取码
    const result: OtpChallengeResult = { challengeId: challenge.id, expiresAt: challenge.expiresAt };
    if (channel.devMode) {
      result.devCode = code;
    }
    return result;
  }

  async verifyCode(dto: OtpLoginDto): Promise<OtpVerificationResult> {
    if (!/^\d{6}$/.test(dto.code)) {
      throw new BadRequestException("验证码必须是 6 位数字");
    }

    const challenge = await this.otpChallenge.findUnique({
      where: { id: dto.challengeId },
    });
    if (!challenge) {
      throw new UnauthorizedException("验证码无效");
    }

    const now = this.now();

    // 输错锁定期内拒绝验证（在消费状态/有效期检查之前，暂停一切验证）。
    if (
      await this.isVerifyLocked(
        this.otpChallenge,
        challenge.channel as OtpChannelType,
        challenge.target,
        now,
      )
    ) {
      throw new OtpVerifyLockedException();
    }

    if (challenge.consumedAt) {
      throw new ConflictException("验证码已经使用过");
    }
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw new GoneException("验证码已过期");
    }
    if (challenge.attempts >= this.maxAttempts) {
      throw new OtpTooManyRequestsException("验证码错误次数已达上限");
    }

    if (!hashesEqual(challenge.codeHash, hashCode(dto.code, this.codeSecret))) {
      const updated = await this.otpChallenge.updateMany({
        where: {
          id: dto.challengeId,
          consumedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: this.maxAttempts },
        },
        data: { attempts: { increment: 1 } },
      });
      if (updated.count === 0) {
        await this.assertChallengeStillVerifiable(dto.challengeId, now);
      }

      // 按邮箱聚合 15min 窗口累计失败尝试（含本次）：达到阈值 → 全部未消费
      // 验证码立即作废 + 进入锁定期（技术方案 §5，不加字段由现有记录推导）。
      if (
        await this.isVerifyLocked(
          this.otpChallenge,
          challenge.channel as OtpChannelType,
          challenge.target,
          now,
        )
      ) {
        await this.otpChallenge.updateMany({
          where: {
            channel: challenge.channel,
            target: challenge.target,
            consumedAt: null,
          },
          data: { consumedAt: now },
        });
        throw new OtpVerifyLockedException();
      }

      if (challenge.attempts + 1 >= this.maxAttempts) {
        throw new OtpTooManyRequestsException("验证码错误次数已达上限");
      }
      throw new UnauthorizedException("验证码错误");
    }

    const consumed = await this.otpChallenge.updateMany({
      where: {
        id: dto.challengeId,
        consumedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: this.maxAttempts },
      },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) {
      await this.assertChallengeStillVerifiable(dto.challengeId, now);
      throw new UnauthorizedException("验证码无效");
    }

    return {
      verified: true,
      challengeId: challenge.id,
      channel: challenge.channel as OtpChannelType,
      target: challenge.target,
    };
  }

  private getChannel(channel: OtpChannelType): OtpChannel {
    const selected = this.channels.find((candidate) => candidate.channel === channel);
    if (!selected) {
      throw new ServiceUnavailableException(`未配置 ${channel} OTP Channel`);
    }
    return selected;
  }

  /** 目标邮箱是否处于输错锁定期（15min 窗口累计失败尝试 ≥ 阈值即锁定，期满自动恢复） */
  private async isVerifyLocked(
    store: OtpChallengeDelegate,
    channel: OtpChannelType,
    target: string,
    now: Date,
  ): Promise<boolean> {
    const lockSince = new Date(now.getTime() - this.verifyLockWindowMs);
    const summed = await store.aggregate({
      where: { channel, target, createdAt: { gte: lockSince } },
      _sum: { attempts: true },
    });
    return (summed._sum.attempts ?? 0) >= this.verifyLockThreshold;
  }

  private async assertRateLimit(
    store: OtpChallengeDelegate,
    channel: OtpChannelType,
    target: string,
    requestIp: string,
    now: Date,
  ): Promise<void> {
    const targetSince = new Date(now.getTime() - this.targetWindowMs);
    const ipSince = new Date(now.getTime() - this.ipWindowMs);
    const hourSince = new Date(now.getTime() - this.sendWindow1hMs);
    const daySince = new Date(now.getTime() - this.sendWindow24hMs);
    const [targetCount, ipCount, hourCount, dayCount, locked] = await Promise.all([
      store.count({
        where: { channel, target, createdAt: { gte: targetSince } },
      }),
      store.count({
        where: { requestIp, createdAt: { gte: ipSince } },
      }),
      store.count({
        where: { channel, target, createdAt: { gte: hourSince } },
      }),
      store.count({
        where: { channel, target, createdAt: { gte: daySince } },
      }),
      this.isVerifyLocked(store, channel, target, now),
    ]);

    // 输错锁定期内拒绝发送（与邮箱维度限流叠加生效）。
    if (locked) {
      throw new OtpVerifyLockedException();
    }
    // 发送上限按已创建的验证码条数统计（发送失败即删、不扣次数）。
    if (hourCount >= this.sendMaxPerHour || dayCount >= this.sendMaxPerDay) {
      throw new OtpSendRateLimitedException();
    }
    if (targetCount >= this.targetMaxRequests || ipCount >= this.ipMaxRequests) {
      throw new OtpTooManyRequestsException("OTP 请求过于频繁，请稍后再试");
    }
  }

  private async assertChallengeStillVerifiable(challengeId: string, now: Date): Promise<void> {
    const current = await this.otpChallenge.findUnique({ where: { id: challengeId } });
    if (!current || current.consumedAt) {
      throw new ConflictException("验证码已经使用过");
    }
    if (current.expiresAt.getTime() <= now.getTime()) {
      throw new GoneException("验证码已过期");
    }
    if (current.attempts >= this.maxAttempts) {
      throw new OtpTooManyRequestsException("验证码错误次数已达上限");
    }
  }
}
