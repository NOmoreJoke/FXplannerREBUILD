-- CreateTable
-- 计划变更记录（plan-management 技术方案 §3.3）。
-- Prisma model PlanChangeLog 走「裸外键」先例：schema 不声明 relation（不触碰冻结基线的 Plan model），
-- 级联删除由本文件的外键约束保证（plan 删除时一并清理变更记录）。
CREATE TABLE "plan_change_logs" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "before_target" DECIMAL(20,4) NOT NULL,
    "after_target" DECIMAL(20,4) NOT NULL,
    "before_alloc" DECIMAL(20,4) NOT NULL,
    "after_alloc" DECIMAL(20,4) NOT NULL,
    "released_amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "before_snapshot" JSONB NOT NULL,
    "after_snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 详情页按计划倒序取变更历史，(plan_id, created_at DESC) 一索引覆盖
CREATE INDEX "plan_change_logs_plan_id_created_at_idx" ON "plan_change_logs"("plan_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "plan_change_logs" ADD CONSTRAINT "plan_change_logs_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- plans 加开始准备日（冻结基线允许的加列演进；存量行为 NULL，重建排期时回退「明天起首个工作日」）
ALTER TABLE "plans" ADD COLUMN "plan_start_date" TIMESTAMPTZ(3);
