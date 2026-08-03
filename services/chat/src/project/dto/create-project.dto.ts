import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import type { CreateProjectDto as ICreateProjectDto } from '@fxplanner-new/contracts';

export class CreateProjectDto implements ICreateProjectDto {
  @IsString()
  @IsNotEmpty({ message: '项目名称不能为空' })
  @MaxLength(100, { message: '项目名称不能超过 100 个字符' })
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(500, { message: '项目描述不能超过 500 个字符' })
  description?: string;
}
