import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
  RateCronService,
  type CronRunSummary,
} from './rate-cron.service';
import {
  LatestRateGroupResponseDto,
  LatestRateQueryDto,
  LatestRateResponseDto,
  RateErrorDto,
} from './dto/rate-latest.dto';
import { RateHistoryDto } from './dto/rate-history.dto';
import { RateHistoryResponseDto } from './dto/rate-history-response.dto';
import { RateService } from './rate.service';

@ApiTags('Rate')
@ApiExtraModels(LatestRateResponseDto, LatestRateGroupResponseDto, RateHistoryResponseDto)
@Controller('rates')
export class RateController {
  constructor(
    @Inject(RateService) private readonly rateService: RateService,
    @Inject(RateCronService) private readonly rateCronService: RateCronService,
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
      '返回 base 兑指定目标的最新报价；5 分钟有效期窗口内命中数据库缓存直接返回；超窗但库内已有报价时立即回显旧值（fresh=false 如实标注陈旧）并后台异步回源落库；库内无报价（冷启动）或 refresh=true 时同步整组回源（同一时点）。'
      + '多源路由：农行牌价（abc，秒级双价）覆盖 HKD/USD/GBP/AUD/CAD/JPY/EUR/SGD/NZD/CHF/THB/KRW，'
      + 'TWD 由 er-api、MYR 由 frankfurter 补齐；RATE_SOURCE=frankfurter 时整组单源降级（TWD 422）。'
      + '仅 abc 源额外返回现汇卖出价 sellRate（录入价取 sellRate ?? rate）。'
      + '单目标（缺省 targets=USD）返回平铺结构；多目标返回 items[] 且错误下沉到项（币对不支持 422 语义、数据源不可用 502 语义）。'
      + '错误兜底场景绝不以旧报价冒充新鲜值（无 0 兑底、无手填汇率）；陈旧回显恒以 fresh=false 标注。',
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
    description: '忽略 5 分钟有效期窗口强制同步回源（确认页锁数、手动刷新等强一致场景用；页面进入已改为陈旧回显 + 后台刷新，不再传 true）',
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
    description: '按 base、target 和 period 查询工作日历史汇率；完整缓存直接返回，缓存不完整时回源并补齐。'
      + ' er-api 路由币对（TWD）本地序列不完整时由 frankfurter v2 参考序列补点（仅响应合并层，不落库），'
      + ' 逐点 source 区分原来源报价与参考价（frankfurter-v2-reference）。',
  })
  @ApiOkResponse({
    description: '历史序列（base/target/period/data_points/current_rate）；逐点含可选 source 来源标注',
    schema: { $ref: getSchemaPath(RateHistoryResponseDto) },
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

  @Post('cron-refresh')
  // 契约恒 200（方案 §5：runOnce 不抛异常，无 500 路径；POST 缺省 201 与契约不符）
  @HttpCode(HttpStatus.OK)
  // 端点级收紧：2 次/分钟/IP（全局限流 10/min 对"全量回源+落库"偏宽；
  // frankfurter/er-api 无源级节流，此为本端点重复触发的外呼闸门，方案 §3.3）
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @ApiOperation({
    summary: '手动触发一轮汇率定时刷新（验证用）',
    description:
      '与定时任务共用 runOnce（CNY 视角 15 币种强制回源落库），等价一轮整点/半点定时轮。'
      + 'runOnce 承诺不抛异常：单源失败在 failed 数组如实呈现，整轮逃逸异常进 fatal，故本端点无 500 路径。'
      + '落库 upsert 幂等（唯一键 base+quote+observedAt），重复触发无副作用积累。',
  })
  @ApiOkResponse({
    description: '轮次摘要：triggeredAt + succeeded/failed 分类；fatal 仅整轮逃逸异常时出现',
  })
  async cronRefresh(): Promise<{ success: boolean; data: CronRunSummary; message: string }> {
    const data = await this.rateCronService.runOnce();
    return {
      success: true,
      data,
      message: '汇率定时刷新（手动触发）完成',
    };
  }
}
