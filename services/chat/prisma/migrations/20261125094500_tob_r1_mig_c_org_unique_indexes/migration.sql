-- ToB R1 MIG-C：将 Account / InitialHolding / Reminder 唯一索引切换至组织维度，
-- 并为 organization_id IS NULL 存量兼容行保留部分唯一索引（保持 M0 基线与旧写兼容）。
BEGIN;

-- Drop old unique indexes and superseded non-unique org lookup indexes
DROP INDEX "accounts_user_id_currency_code_key";
DROP INDEX "accounts_organization_id_currency_code_idx";
DROP INDEX "initial_holdings_user_id_currency_code_key";
DROP INDEX "initial_holdings_organization_id_currency_code_idx";
DROP INDEX "reminders_user_id_dedup_key_scheduled_for_key";

-- Organization-scoped unique indexes (Prisma schema @@unique)
CREATE UNIQUE INDEX "accounts_organization_id_currency_code_key" ON "accounts"("organization_id", "currency_code");
CREATE UNIQUE INDEX "initial_holdings_organization_id_currency_code_key" ON "initial_holdings"("organization_id", "currency_code");
CREATE UNIQUE INDEX "reminders_organization_id_dedup_key_scheduled_for_key" ON "reminders"("organization_id", "dedup_key", "scheduled_for");

-- Non-unique user-scoped indexes (Prisma schema @@index)
CREATE INDEX "accounts_user_id_currency_code_idx" ON "accounts"("user_id", "currency_code");
CREATE INDEX "initial_holdings_user_id_currency_code_idx" ON "initial_holdings"("user_id", "currency_code");
CREATE INDEX "reminders_user_id_dedup_key_scheduled_for_idx" ON "reminders"("user_id", "dedup_key", "scheduled_for");

-- Partial unique indexes for legacy organization_id IS NULL rows
CREATE UNIQUE INDEX "accounts_legacy_user_currency_uidx" ON "accounts"("user_id", "currency_code") WHERE "organization_id" IS NULL;
CREATE UNIQUE INDEX "initial_holdings_legacy_user_currency_uidx" ON "initial_holdings"("user_id", "currency_code") WHERE "organization_id" IS NULL;
CREATE UNIQUE INDEX "reminders_legacy_user_dedup_scheduled_uidx" ON "reminders"("user_id", "dedup_key", "scheduled_for") WHERE "organization_id" IS NULL;

COMMIT;
