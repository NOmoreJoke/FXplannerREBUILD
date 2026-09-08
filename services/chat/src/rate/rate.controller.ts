import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SUPPORTED_CURRENCIES, VALID_PERIODS } from './rate.constants';
import { RateHistoryDto } from './dto/rate-history.dto';
import { RateService } from './rate.service';

@ApiTags('Rate')
@Controller('rates')
export class RateController {
  constructor(
    @Inject(RateService) private readonly rateService: RateService,
  ) {}

  @Get('supported')
  @ApiOperation({
    summary: '查询支持的货币代码',
    description: '返回汇率模块当前支持的全部 ISO 4217 货币代码，供前端选择器和参数校验使用。',
  })
  supported() {
    return {
      success: true,
      data: this.rateService.getSupported(),
      message: '支持的币种查询成功',
    };
  }

  @Get('latest/:base')
  @ApiOperation({
    summary: '查询指定货币兑美元的最新汇率',
    description: '返回 base 兑换 USD 的最新报价；优先读取 24 小时内的数据库缓存，缓存缺失或过期时回源 Frankfurter。',
  })
  @ApiParam({
    name: 'base',
    description: '基准货币代码',
    enum: [...SUPPORTED_CURRENCIES],
    example: 'USD',
  })
  async latest(@Param('base') base: string) {
    const data = await this.rateService.getLatest(base);
    return {
      success: true,
      data,
      message: '最新汇率查询成功',
    };
  }

  @Get('history')
  @ApiOperation({
    summary: '查询历史汇率序列',
    description: '按 base、target 和 period 查询工作日历史汇率；完整缓存直接返回，缓存不完整时回源并补齐。',
  })
  @ApiQuery({
    name: 'base',
    description: '基准货币代码',
    required: false,
    enum: [...SUPPORTED_CURRENCIES],
    example: 'USD',
    default: 'USD',
  })
  @ApiQuery({
    name: 'target',
    description: '目标货币代码',
    required: false,
    enum: [...SUPPORTED_CURRENCIES],
    example: 'CNY',
    default: 'CNY',
  })
  @ApiQuery({
    name: 'period',
    description: '查询天数',
    required: false,
    enum: [...VALID_PERIODS],
    example: 30,
    default: 30,
    type: Number,
  })
  async history(
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        expectedType: RateHistoryDto,
      }),
    )
    dto: RateHistoryDto,
  ) {
    const data = await this.rateService.getHistory(dto.base, dto.target, dto.period);
    return {
      success: true,
      data,
      message: '历史汇率查询成功',
    };
  }
}
