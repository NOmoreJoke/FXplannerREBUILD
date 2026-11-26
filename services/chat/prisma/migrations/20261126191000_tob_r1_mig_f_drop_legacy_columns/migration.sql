-- Migration: 20261126191000_tob_r1_mig_f_drop_legacy_columns
-- Goal #3C W30 · 技术方案 §12.1「MIG-F 清理」
--
-- 目标（生产代码零引用确认后方可执行，见 GOAL-3C W30 清单）：
--   1. user_settings 删除 4 个已迁往 OrganizationSettings 的业务列；
--   2. reminders 删除 read_at（已读态由成员级 reminder_reads 承载）；
--   3. 8 张共享账本表删除冗余 user_id（组织归属由 organization_id 唯一承担）；
--   4. data_requests.user_id 重命名为 requester_user_id 并改 ON DELETE SET NULL
--      ——用户注销后保留请求记录本身，不再随 User 级联删除。
--
-- 前置：MIG-E 已执行（organization_id NOT NULL、账本表直连 Organization）。

-- ─────────────────────────────────────────────────────────────
-- 1. user_settings：删除已迁往 OrganizationSettings 的业务列
--    （保留 id / user_id / locale / region / created_at / updated_at）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "base_currency";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "prep_preference";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "reminder_enabled";
ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "ledger_started_at";

-- ─────────────────────────────────────────────────────────────
-- 2. reminders：删除个人读态列（成员级已读在 reminder_reads）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "reminders" DROP COLUMN IF EXISTS "read_at";

-- ─────────────────────────────────────────────────────────────
-- 3. 8 张共享账本表：删除冗余 user_id
--    （MIG-E 已删除其 ON DELETE CASCADE 外键与 (user_id, ...) 索引，
--      此处 DROP COLUMN 会连带清掉残余的列默认/注释）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "accounts"         DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "transactions"    DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "initial_holdings" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "cost_lots"        DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "plans"            DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "usage_records"    DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "corrections"      DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "reminders"        DROP COLUMN IF EXISTS "user_id";

-- ─────────────────────────────────────────────────────────────
-- 4. data_requests：user_id → requester_user_id（可空 + ON DELETE SET NULL）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "data_requests" RENAME COLUMN "user_id" TO "requester_user_id";
ALTER TABLE "data_requests" ALTER COLUMN "requester_user_id" DROP NOT NULL;

-- 旧外键（ON DELETE CASCADE）随列重命名保留原名，需显式删除后重建
ALTER TABLE "data_requests" DROP CONSTRAINT IF EXISTS "data_requests_user_id_fkey";
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- 状态索引随之改名（列已重命名，索引定义不变，仅换名）
ALTER INDEX IF EXISTS "data_requests_user_id_status_idx" RENAME TO "data_requests_requester_user_id_status_idx";
