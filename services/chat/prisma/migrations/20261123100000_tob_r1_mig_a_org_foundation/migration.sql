-- ToB R1 MIG-A：组织地基增量迁移（技术方案 §5.1 / §12.1；Goal #3A W14）
-- 纯增量：新增 6 表 + 既有 11 业务表加可空租户列与索引；不修改任何既有列/约束，
-- 旧代码仍按 userId 读写。空壳兼容性由既有全量 L1/L2 测试零回归锁定。
BEGIN;

-- AlterTable（MIG-A 增量可空列；不改任何既有列与约束）
ALTER TABLE "accounts" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "initial_holdings" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "cost_lots" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "plan_change_logs" ADD COLUMN     "actor_user_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "created_by_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "corrections" ADD COLUMN     "actor_user_id" TEXT,
ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "organization_id" TEXT;

-- AlterTable
ALTER TABLE "data_requests" ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'PERSONAL';

-- AlterTable
ALTER TABLE "ai_conversations" ADD COLUMN     "organization_id" TEXT;

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "prep_preference" TEXT NOT NULL DEFAULT 'balanced',
    "reminder_enabled" BOOLEAN NOT NULL DEFAULT true,
    "ledger_started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "result" TEXT NOT NULL,
    "request_id" TEXT,
    "agent_run_id" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_reads" (
    "id" TEXT NOT NULL,
    "reminder_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memberships_user_id_status_idx" ON "memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "memberships_organization_id_status_role_idx" ON "memberships"("organization_id", "status", "role");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_email_created_at_idx" ON "organization_invitations"("organization_id", "email", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "organization_settings_organization_id_key" ON "organization_settings"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_actor_user_id_created_at_idx" ON "audit_logs"("organization_id", "actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_reads_reminder_id_user_id_key" ON "reminder_reads"("reminder_id", "user_id");

-- CreateIndex
CREATE INDEX "accounts_organization_id_currency_code_idx" ON "accounts"("organization_id", "currency_code");

-- CreateIndex
CREATE INDEX "transactions_organization_id_transacted_at_idx" ON "transactions"("organization_id", "transacted_at");

-- CreateIndex
CREATE INDEX "initial_holdings_organization_id_currency_code_idx" ON "initial_holdings"("organization_id", "currency_code");

-- CreateIndex
CREATE INDEX "cost_lots_organization_id_currency_code_acquired_at_idx" ON "cost_lots"("organization_id", "currency_code", "acquired_at");

-- CreateIndex
CREATE INDEX "plans_organization_id_status_idx" ON "plans"("organization_id", "status");

-- CreateIndex
CREATE INDEX "plan_change_logs_organization_id_plan_id_created_at_idx" ON "plan_change_logs"("organization_id", "plan_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "usage_records_organization_id_used_at_idx" ON "usage_records"("organization_id", "used_at");

-- CreateIndex
CREATE INDEX "corrections_organization_id_target_type_target_id_idx" ON "corrections"("organization_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "reminders_organization_id_scheduled_for_idx" ON "reminders"("organization_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "data_requests_organization_id_status_idx" ON "data_requests"("organization_id", "status");

-- CreateIndex
CREATE INDEX "ai_conversations_user_id_organization_id_updated_at_idx" ON "ai_conversations"("user_id", "organization_id", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_reads" ADD CONSTRAINT "reminder_reads_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_reads" ADD CONSTRAINT "reminder_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 单活跃 Owner 不变量（技术方案 §5.1）：同组织至多一个 OWNER+ACTIVE 成员。
-- 所有权转移事务必须先降原 Owner 再升新 Owner（W19 transfer-ownership 顺序保护）。
CREATE UNIQUE INDEX "memberships_single_active_owner_uidx" ON "memberships" ("organization_id") WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';

COMMIT;
