import {
	Body,
	Controller,
	Get,
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
import { SkipPersonalAccountLock } from "../authorization/guards/data-lock.decorators";
import {
	CancelDataRequestDto,
	CreateDataRequestDto,
	DataRequestConflictBodyDto,
	DataRequestErrorDto,
	DataRequestViewDto,
	LastOwnerRequiredBodyDto,
	BlockingOrganizationDto,
	VerifyDataRequestDto,
	VerifyResultDto,
} from "./dto/data-request.dto";

/**
 * 个人域数据权利请求（技术方案 §9.1–§9.2；Goal #3B W27）。
 *
 * **物理拆分后的个人域端点**（5 个）：进度 / 验证 / 创建 / 撤回 / 下载。
 * - 只受理 `scope = PERSONAL` 的 `EXPORT` / `DELETION`：传 `scope = ORGANIZATION`
 *   或 `type = CLEAR` 一律 400 SCOPE_TYPE_MISMATCH（清空与组织数据权利请走
 *   组织端点 `/api/organizations/current/data-requests/*`）；
 * - 只挂 JwtAuthGuard，**不要求 X-Organization-Id**（个人数据权利与组织无关）；
 * - 类级 @SkipPersonalAccountLock()：注销处理中仍可查看进度、撤回、下载
 *   （白名单即「403 → 前端跳进度页」闭环的目的地）。
 */
@ApiTags("DataRequest")
@ApiBearerAuth()
@ApiExtraModels(DataRequestViewDto, VerifyResultDto)
@Controller("data-requests")
@UseGuards(JwtAuthGuard)
@SkipPersonalAccountLock()
export class DataRequestController {
	constructor(
		@Inject(DataRequestService)
		private readonly dataRequestService: DataRequestService,
	) {}

	@Get("current")
	@ApiOperation({
		summary: "查询当前个人数据请求（进度页）",
		description:
			"返回最近 30 天内本人最新一条非撤回**个人域**请求的进度视图（含展示状态映射、可否撤回、下载入口）；无进行中个人请求返回 null。组织域进度见 GET /api/organizations/current/data-requests/current。",
	})
	@ApiOkResponse({
		description: "当前个人请求视图或 null",
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
		const data = await this.dataRequestService.getCurrentView(user.id, "PERSONAL");
		return { success: true, data, message: "查询成功" };
	}

	@Post("verify")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "个人数据操作验证码校验（生成 10 分钟确认凭证）",
		description:
			"校验 challenge 用途（LOGIN 不放行）并消费验证码，返回确认截止时刻（消费 +10 分钟）；用途不匹配 403 VERIFICATION_PURPOSE_MISMATCH，码错沿用 OTP 语义。本端点只服务个人域操作；组织域验证码请用 POST /api/organizations/current/data-requests/verify。",
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
		summary: "提交个人数据请求（EXPORT 同步生成 / DELETION 进入 7 日流程）",
		description:
			"仅受理个人域（PERSONAL）的 EXPORT / DELETION：传 scope = ORGANIZATION 或 type = CLEAR 一律 400 SCOPE_TYPE_MISMATCH（组织数据权利见 POST /api/organizations/current/data-requests）。需 verify 返回的确认凭证（10 分钟内、一次性）；互斥 409 附原请求视图；个人注销时本人仍是某组织唯一所有者 → 409 LAST_OWNER_REQUIRED 附阻塞组织列表。提交 DELETION 时本人个人域可下载导出链接立即失效。",
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
			"互斥（DATA_REQUEST_CONFLICT 附原请求）/ 个人注销的最后 Owner 保护（LAST_OWNER_REQUIRED 附阻塞组织列表）",
		type: DataRequestConflictBodyDto,
	})
	@ApiExtraModels(LastOwnerRequiredBodyDto, BlockingOrganizationDto)
	@HttpCode(HttpStatus.OK)
	async create(
		@CurrentUser() user: User,
		@Body() dto: CreateDataRequestDto,
	) {
		const data = await this.dataRequestService.create(dto, user, {
			scope: "PERSONAL",
			organizationId: null,
			membershipId: null,
		});
		return { success: true, data, message: "请求已提交" };
	}

	@Post(":id/cancel")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "撤回个人请求",
		description:
			"DELETION PENDING 需携带 purpose=DELETION 的新验证凭证（仅登录不算撤回）；EXPORT 无取消窗口；非本人 / 组织域请求 / 不存在一律 404（不泄露存在性）。",
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
	@ApiNotFoundResponse({ description: "请求不存在 / 非本人 / 非个人域", type: DataRequestErrorDto })
	@ApiConflictResponse({ description: "当前状态不可撤回", type: DataRequestErrorDto })
	async cancel(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Body() dto: CancelDataRequestDto,
	) {
		const data = await this.dataRequestService.cancel(id, user, dto, {
			scope: "PERSONAL",
			organizationId: null,
			membershipId: null,
		});
		return { success: true, data, message: "已撤回" };
	}

	@Get(":id/download")
	@ApiOperation({
		summary: "下载个人导出包（ZIP 流式返回）",
		description:
			"仅本人**个人域** EXPORT COMPLETED 且 24 小时内可下载；过期/文件已清理 410 DOWNLOAD_EXPIRED；非本人 / 组织域请求 404（不泄露存在性）。组织导出包请用 GET /api/organizations/current/data-requests/{id}/download。",
	})
	@ApiOkResponse({
		description: "ZIP 二进制（Content-Disposition 附件下载）",
		schema: { type: "string", format: "binary" },
	})
	@ApiGoneResponse({ description: "下载链接已失效", type: DataRequestErrorDto })
	@ApiNotFoundResponse({ description: "请求不存在 / 非本人 / 非个人域", type: DataRequestErrorDto })
	async download(
		@CurrentUser() user: User,
		@Param("id") id: string,
		@Res({ passthrough: true }) res: Response,
	): Promise<StreamableFile> {
		const { buffer, filename } = await this.dataRequestService.loadDownload(
			id,
			user.id,
			{ scope: "PERSONAL", organizationId: null, membershipId: null },
		);
		res.set({
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Content-Length": String(buffer.length),
		});
		return new StreamableFile(buffer);
	}
}
