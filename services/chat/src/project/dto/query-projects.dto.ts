import { IsInt, IsOptional, IsString, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import type { QueryProjectsDto as IQueryProjectsDto } from '@fxplanner-new/contracts';

export class QueryProjectsDto implements IQueryProjectsDto {
  @IsInt()
  @Min(1, { message: '页码最小为 1' })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsInt()
  @Min(1, { message: '每页数量最小为 1' })
  @Max(100, { message: '每页数量最大为 100' })
  @IsOptional()
  @Type(() => Number)
  pageSize?: number = 20;

  @IsString()
  @IsIn(['createdAt', 'updatedAt', 'name'], {
    message: '排序字段必须是 createdAt、updatedAt 或 name',
  })
  @IsOptional()
  orderBy?: 'createdAt' | 'updatedAt' | 'name' = 'updatedAt';

  @IsString()
  @IsIn(['asc', 'desc'], { message: '排序顺序必须是 asc 或 desc' })
  @IsOptional()
  order?: 'asc' | 'desc' = 'desc';
}
