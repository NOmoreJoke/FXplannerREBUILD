import { IsString, IsOptional, MaxLength } from 'class-validator';
import type { UpdateProjectDto as IUpdateProjectDto } from '@fxplanner-new/contracts';

export class UpdateProjectDto implements IUpdateProjectDto {
  @IsString()
  @IsOptional()
  @MaxLength(100, { message: '项目名称不能超过 100 个字符' })
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500, { message: '项目描述不能超过 500 个字符' })
  description?: string;
}
