import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { SUPPORTED_CURRENCIES, VALID_PERIODS } from './rate.constants';
import {
  LatestRateGroupResponseDto,
  LatestRateQueryDto,
  LatestRateResponseDto,
  RateErrorDto,
} from './dto/rate-latest.dto';
import { RateHistoryDto } from './dto/rate-history.dto';
import { RateService } from './rate.service';

@ApiTags('Rate')
@ApiExtraModels(LatestRateResponseDto, LatestRateGroupResponseDto)
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
    summary: '查询最新汇率（支持多目标批量）',
    description:
      '返回 base 兑指定目标的最新报价；5 分钟有效期窗口内命中数据库缓存，过期或 refresh=true 时整组回源（同一时点）。'
      + '多源路由：农行牌价（abc，秒级双价）覆盖 HKD/USD/GBP/AUD/CAD/JPY/EUR/SGD/NZD/CHF/THB/KRW，'
      + 'TWD 由 er-api、MYR 由 frankfurter 补齐；RATE_SOURCE=frankfurter 时整组单源降级（TWD 422）。'
      + '仅 abc 源额外返回现汇卖出价 sellRate（录入价取 sellRate ?? rate）。'
      + '单目标（缺省 targets=USD）返回平铺结构；多目标返回 items[] 且错误下沉到项（币对不支持 422 语义、数据源不可用 502 语义）。'
      + '绝不返回过期报价，无 0 兑底、无手填汇率。',
  })
  @ApiParam({
    name: 'base',
    description: '基准货币代码',
    enum: [...SUPPORTED_CURRENCIES],
    example: 'USD',
  })
  @ApiQuery({
    name: 'targets',
    description: '逗号分隔的目标币种（≤15 个，须在支持清单内）；缺省 USD。与 base 相同的币种返回恒等报价（rate=1）',
    required: false,
    example: 'CNY,JPY',
  })
  @ApiQuery({
    name: 'refresh',
    description: '忽略 5 分钟有效期窗口，强制回源（录入页进入刷新、最终确认前重查用）',
    required: false,
    type: Boolean,
    default: false,
  })
  @ApiOkResponse({
    description: '单目标平铺结构或多目标 items 结构',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(LatestRateResponseDto) },
        { $ref: getSchemaPath(LatestRateGroupResponseDto) },
      ],
    },
  })
  @ApiBadRequestResponse({
    description: '参数非法：币种不在支持清单、targets 超量',
  })
  @ApiUnprocessableEntityResponse({
    description: '数据源不提供该币对报价（如 ECB 无 TWD），重试无用',
    type: RateErrorDto,
  })
  @ApiBadGatewayResponse({
    description: '汇率数据源暂时不可用（网络失败/5xx/超时），响应体含库中最后报价时间 lastObservedAt',
    type: RateErrorDto,
  })
  async latest(
    @Param('base') base: string,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        expectedType: LatestRateQueryDto,
      }),
    )
    dto: LatestRateQueryDto,
  ) {
    const data = await this.rateService.getLatest(base, dto.targets, dto.refresh);
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
