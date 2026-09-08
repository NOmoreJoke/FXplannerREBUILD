import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("System")
@Controller()
export class AppController {
  @Get("health")
  @ApiOperation({
    summary: "检查服务健康状态",
    description:
      "供本地开发、部署探针和监控系统确认 API 服务可用；服务正常时返回 ok=true。",
  })
  getHealth(): { ok: boolean } {
    return { ok: true };
  }
}
