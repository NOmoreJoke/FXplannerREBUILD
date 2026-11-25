import {
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	HttpStatus,
	Inject,
	Param,
	Post,
	Res,
	UseGuards,
} from "@nestjs/common";
import {
	ApiBearerAuth,
	ApiBody,
	ApiConflictResponse,
	ApiExtraModels,
	ApiForbiddenResponse,
	ApiGoneResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { StreamableFile } from "@nestjs/common";
import type { User } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { DataRequestService } from "./data-request.service";
import { SkipDataRequestLock } from "./data-request-lock.guard";
import {
	BlockingOrganizationDto,
	CancelDataRequestDto,
	CreateDataRequestDto,
	DataRequestConflictBodyDto,
	DataRequestErrorDto,
	DataRequestViewDto,
	ImpactViewDto,
	LastOwnerRequiredBodyDto,
	VerifyDataRequestDto,
	VerifyResultDto,
} from "./dto/data-request.dto";

/**
 * 数据权利请求（account-data 技术方案 §7）：进度/影响/验证/创建/撤回/下载六端点。
 *
 * 全部端点标注 @SkipDataRequestLock：注销/清空处理中仍可查看进度、撤回、下载
 * （白名单即「403 → 前端跳进度页」闭环的目的地）。
 */
@ApiTags("DataRequest")
@ApiBearerAuth()
@ApiExtraModels(DataRequestViewDto, VerifyResultDto, ImpactViewDto)
@Controller("data-requests")
@UseGuards(JwtAuthGuard)
@SkipDataRequestLock()
export class DataRequestController {
	constructor(
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	@Get("current")
	@ApiOperation({
		summary: "查询当前数据请求（进度页）",
		description:
			"返回最近 30 天内最新一条非撤回请求的进度视图（含展示状态映射、可否撤回、下载入口）；无进行中请求返回 null。",
	})
	@ApiOkResponse({
		description: "当前请求视图或 null",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: {
					oneOf: [
						{ $ref: "#/components/schemas/DataRequestViewDto" },
						{ type: "null" },
					],
				},
				message: { type: "string" },
			},
		},
	})
	async getCurrent(@CurrentUser() user: User) {
		const data = await this.dataRequestService.getCurrentView(user.id);
		return { success: true, data, message: "查询成功" };
	}

	@Get("impact")
	@ApiOperation({
		summary: "查询清空影响（确认页）",
		description:
			"返回**当前组织**各业务记录数量与是否存在可下载的组织导出包（目标组织取 X-Organization-Id，单组织用户可缺省；需 data.clear 权限）；CLEAR 提交时的 confirmedTotals 快照与此比对，不一致 409 IMPACT_CHANGED。",
	})
	@ApiOkResponse({
		description: "记录数量与可下载导出提示",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/ImpactViewDto" },
				message: { type: "string" },
			},
		},
	})
	async getImpact(
		@CurrentUser() user: User,
		@Headers("x-organization-id") organizationHeader?: string | string[],
	) {
		const data = await this.dataRequestService.getImpact(user.id, organizationHeader);
		return { success: true, data, message: "查询成功" };
	}

	@Post("verify")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "数据操作验证码校验（生成 10 分钟确认凭证）",
		description:
			"校验 challenge 用途（LOGIN 不放行）并消费验证码，返回确认截止时刻（消费 +10 分钟）；用途不匹配 403 VERIFICATION_PURPOSE_MISMATCH，码错沿用 OTP 语义。",
	})
	@ApiBody({ type: VerifyDataRequestDto })
	@ApiOkResponse({
		description: "验证通过，返回确认凭证与截止时刻",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/VerifyResultDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiForbiddenResponse({
		description: "用途不匹配 / 验证码无效",
		type: DataRequestErrorDto,
	})
	async verify(@CurrentUser() user: User, @Body() dto: VerifyDataRequestDto) {
		const data = await this.dataRequestService.verify(dto, user);
		return { success: true, data, message: "验证成功" };
	}

	@Post()
	@ApiOperation({
		summary: "提交数据请求（EXPORT 同步生成 / CLEAR、DELETION 进入 7 日流程）",
		description:
			"需 verify 返回的确认凭证（10 分钟内、一次性）；互斥 409 附原请求视图；个人注销时本人仍是某组织唯一所有者 → 409 LAST_OWNER_REQUIRED 附阻塞组织列表。数据域 scope 缺省按类型归属：CLEAR = 当前组织的 ORGANIZATION（目标组织取 X-Organization-Id，单组织用户可缺省，需 data.clear；必带 confirmedTotals 且与服务端重算一致），EXPORT / DELETION = PERSONAL（仅本人 + 二次验证，不含组织账本）。提交 CLEAR/DELETION 时同域可下载导出链接立即失效。",
	})
	@ApiBody({ type: CreateDataRequestDto })
	@ApiOkResponse({
		description: "请求视图（EXPORT 为 COMPLETED 含下载入口）",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/DataRequestViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiConflictResponse({
		description:
			"互斥（DATA_REQUEST_CONFLICT 附原请求）/ 影响变化（IMPACT_CHANGED）/ 个人注销的最后 Owner 保护（LAST_OWNER_REQUIRED 附阻塞组织列表）",
		type: DataRequestConflictBodyDto,
	})
	@ApiExtraModels(LastOwnerRequiredBodyDto, BlockingOrganizationDto)
	@HttpCode(HttpStatus.OK)
	async create(
		@CurrentUser() user: User,
		@Body() dto: CreateDataRequestDto,
		@Headers("x-organization-id") organizationHeader?: string | string[],
	) {
		const data = await this.dataRequestService.create(dto, user, organizationHeader);
		return { success: true, data, message: "请求已提交" };
	}

	@Post(":id/cancel")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "撤回请求",
		description:
			"CLEAR PENDING 直接撤回（原记录原样恢复）；DELETION PENDING 需携带 purpose=DELETION 的新验证凭证（仅登录不算撤回）；EXPORT 无取消窗口；非本人/不存在 404。",
	})
	@ApiBody({ type: CancelDataRequestDto })
	@ApiOkResponse({
		description: "撤回后的请求视图（CANCELLED）",
		schema: {
			properties: {
				success: { type: "boolean", example: true },
				data: { $ref: "#/components/schemas/DataRequestViewDto" },
				message: { type: "string" },
			},
		},
	})
	@ApiForbiddenResponse({ description: "DELETION 撤回缺验证凭证", type: DataRequestErrorDto })
	@ApiNotFoundResponse({ description: "请求不存在或非本人", type: DataRequestErrorDto })
	@ApiConflictResponse({ description: "当前状态不可撤回", type: DataRequestErrorDto })
	async cancel(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Body() dto: CancelDataRequestDto,
	) {
		const data = await this.dataRequestService.cancel(id, user, dto);
		return { success: true, data, message: "已撤回" };
	}

	@Get(":id/download")
	@ApiOperation({
		summary: "下载导出包（ZIP 流式返回）",
		description:
			"仅本人 EXPORT COMPLETED 且 24 小时内可下载；过期/文件已清理 410 DOWNLOAD_EXPIRED；非本人 404（不泄露存在性）。",
	})
	@ApiOkResponse({
		description: "ZIP 二进制（Content-Disposition 附件下载）",
		schema: { type: "string", format: "binary" },
	})
	@ApiGoneResponse({ description: "下载链接已失效", type: DataRequestErrorDto })
	@ApiNotFoundResponse({ description: "请求不存在或非本人", type: DataRequestErrorDto })
	async download(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Res({ passthrough: true }) res: Response,
	): Promise<StreamableFile> {
		const { buffer, filename } = await this.dataRequestService.loadDownload(
			id,
			user.id,
		);
		res.set({
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Content-Length": String(buffer.length),
		});
		return new StreamableFile(buffer);
	}
}
