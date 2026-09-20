-- M9 提醒与到期处理（changes/reminders/技术方案.md §5）：
-- reminders 增加 read_at（已读标记）+ [user_id, scheduled_for] 列表查询索引。
-- 注：不包含 prisma migrate dev 自动生成的 plan_change_logs FK DROP——该 FK 为
-- 20260915120000_add_plan_change_logs 手写的裸外键级联（schema 注释明示），非本模块 drift。

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "read_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "reminders_user_id_scheduled_for_idx" ON "reminders"("user_id", "scheduled_for");
