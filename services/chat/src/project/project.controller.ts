import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import { CreateProjectDto, UpdateProjectDto, QueryProjectsDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('projects')
@UseGuards(JwtAuthGuard)  // 启用 JWT 认证
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  async create(@Request() req: any, @Body() createProjectDto: CreateProjectDto) {
    const userId = req.user.id;

    const project = await this.projectService.create(userId, createProjectDto);
    return {
      success: true,
      data: project,
      message: '项目创建成功',
    };
  }

  @Get()
  async findAll(@Request() req: any, @Query() query: QueryProjectsDto) {
    const userId = req.user.id;

    const result = await this.projectService.findAll(userId, query);
    return {
      success: true,
      data: result,  // 整个 result 包含 { data: [...], pagination: {...} }
    };
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    const userId = req.user.id;

    const project = await this.projectService.findOne(userId, id);
    return {
      success: true,
      data: project,
    };
  }

  @Patch(':id')
  async update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() updateProjectDto: UpdateProjectDto,
  ) {
    const userId = req.user.id;

    const project = await this.projectService.update(userId, id, updateProjectDto);
    return {
      success: true,
      data: project,
      message: '项目更新成功',
    };
  }

  @Delete(':id')
  async remove(@Request() req: any, @Param('id') id: string) {
    const userId = req.user.id;

    await this.projectService.remove(userId, id);
    return {
      success: true,
      message: '项目删除成功',
    };
  }
}
