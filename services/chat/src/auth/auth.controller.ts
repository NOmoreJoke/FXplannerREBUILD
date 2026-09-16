import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

// 认证接口限流上限（次/分钟）：默认 5；E2E 集中造数经 AUTH_THROTTLE_LIMIT 放大（.env.local 已由 dotenv -e 注入 process.env）
const AUTH_THROTTLE_LIMIT = Number(process.env.AUTH_THROTTLE_LIMIT ?? 5);
const AUTH_OTP_THROTTLE_LIMIT = Number(process.env.AUTH_OTP_THROTTLE_LIMIT ?? 10);
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto';
import { AuthResponseDto, UserDto } from './dto/auth-response.dto';
import { SendOtpCodeDto } from './otp/dto/send-otp-code.dto';
import { OtpChallengeResultDto } from './otp/dto/otp-challenge-result.dto';
import { OtpLoginDto } from './otp/dto/otp-login.dto';
import { OtpService } from './otp/otp.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { User } from '@prisma/client';
import type { Request } from 'express';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(OtpService) private readonly otpService: OtpService,
  ) {}

  @Post('register')
  @ApiOperation({
    summary: '使用邮箱和密码注册',
    description: '创建密码账号并签发 JWT；同一邮箱后续通过 OTP 登录时，会验证通过后直接登录并绑定到本账号（仅绑定，不迁移历史数据）。',
  })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      '注册成功。响应体为 { success, data: AuthResponseDto, message } 包装，data 为签发的用户与 JWT。',
    type: AuthResponseDto,
  })
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    const data = await this.authService.register(dto);
    return {
      success: true,
      data,
      message: '注册成功',
    };
  }

  @Post('login')
  @ApiOperation({
    summary: '使用邮箱和密码登录',
    description: '校验密码账号并签发 JWT；没有 passwordHash 的 OTP 独立账号不能使用此入口。',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      '登录成功。响应体为 { success, data: AuthResponseDto, message } 包装，data 为用户与 JWT。',
    type: AuthResponseDto,
  })
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    const data = await this.authService.login(dto);
    return {
      success: true,
      data,
      message: '登录成功',
    };
  }

  @Post('otp/send-code')
  @ApiOperation({
    summary: '发送 OTP 登录验证码',
    description: '向邮箱或手机号发送 6 位登录验证码，并返回 challengeId 和过期时间；此步骤不会登录或签发 JWT。',
  })
  @ApiBody({ type: SendOtpCodeDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      '已发送。响应体为 { success, data: OtpChallengeResultDto, message } 包装，此步骤不登录。',
    type: OtpChallengeResultDto,
  })
  @Throttle({ default: { limit: AUTH_THROTTLE_LIMIT, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async sendOtpCode(@Body() dto: SendOtpCodeDto, @Req() req: Request) {
    const forwardedFor = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
    const requestIp = forwardedFor || req.ip || 'unknown';
    const data = await this.otpService.sendCode(dto, requestIp);
    return {
      success: true,
      data,
      message: '验证码已发送',
    };
  }

  @Post('otp/login')
  @ApiOperation({
    summary: '使用 OTP 登录',
    description: '校验并消费 challengeId 对应的验证码后按优先级登录：已有 OTP 标识则复用原账号；email 渠道且同邮箱存在密码账号则登录该账号并绑定此 OTP 标识（不新建 User）；否则创建独立 OTP 账号，然后签发 JWT。',
  })
  @ApiBody({ type: OtpLoginDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      '登录成功。响应体为 { success, data: AuthResponseDto, message } 包装，data 含 identity 绑定信息。',
    type: AuthResponseDto,
  })
  @Throttle({ default: { limit: AUTH_OTP_THROTTLE_LIMIT, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  async loginWithOtp(@Body() dto: OtpLoginDto) {
    const verification = await this.otpService.verifyCode(dto);
    const data = await this.authService.loginWithOtp(verification);
    return {
      success: true,
      data,
      message: 'OTP 登录成功',
    };
  }

  @Get('me')
  @ApiOperation({
    summary: '获取当前登录用户',
    description: '使用 Bearer JWT 查询当前用户，仅返回 id、email、name、avatar 和 createdAt 等公开字段。',
  })
  @ApiBearerAuth()
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      '查询成功。响应体为 { success, data: UserDto } 包装，仅含公开字段。',
    type: UserDto,
  })
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async getMe(@CurrentUser() user: User) {
    const data = await this.authService.getMe(user.id);
    return {
      success: true,
      data,
    };
  }
}
