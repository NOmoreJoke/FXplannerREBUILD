-- Migration: 20261126190000_tob_r1_mig_e_tighten_constraints
-- Goal #3C W30 · 技术方案 §12.1「MIG-E 收紧约束」+ §5.3「租户完整性与索引」
--
-- 目标：
--   1. 10 张业务表的 organization_id 收紧为 NOT NULL（兼容窗口彻底关闭）；
--   2. 清理过渡期部分唯一索引与冗余 (user_id, ...) 索引；
--   3. 共享账本表与 Organization 建立直连外键（ON DELETE RESTRICT），
--      与 User 解绑（作者列改 ON DELETE SET NULL）——确保 PERSONAL DELETION
--      在数据库层面也不可能误级联删除企业账本（技术方案 §5.3 #4–5）。
--
-- fail-closed 纪律：任一预检不通过即 RAISE EXCEPTION 中止整份迁移，
-- 绝不带病收紧约束（技术方案 §12.4 / GOAL-3C 不可逆操作保护）。

-- ─────────────────────────────────────────────────────────────
-- 1. Fail-closed 预检
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_null_rows        bigint;
  v_missing_org_rows bigint;
  v_bad_parent_child bigint;
  v_detail           text;
BEGIN
  -- 1.1 10 张业务表不得残留 organization_id IS NULL 行（须先跑 MIG-B 回填 + verify）
  SELECT
      (SELECT count(*) FROM accounts         WHERE organization_id IS NULL)
    + (SELECT count(*) FROM transactions    WHERE organization_id IS NULL)
    + (SELECT count(*) FROM initial_holdings WHERE organization_id IS NULL)
    + (SELECT count(*) FROM cost_lots        WHERE organization_id IS NULL)
    + (SELECT count(*) FROM plans            WHERE organization_id IS NULL)
    + (SELECT count(*) FROM plan_change_logs WHERE organization_id IS NULL)
    + (SELECT count(*) FROM usage_records    WHERE organization_id IS NULL)
    + (SELECT count(*) FROM corrections      WHERE organization_id IS NULL)
    + (SELECT count(*) FROM reminders        WHERE organization_id IS NULL)
    + (SELECT count(*) FROM ai_conversations WHERE organization_id IS NULL)
  INTO v_null_rows;

  IF v_null_rows <> 0 THEN
    RAISE EXCEPTION
      'MIG-E 中止：10 张业务表仍有 % 行 organization_id IS NULL（须先执行 MIG-B 回填并跑 verify 归零）',
      v_null_rows;
  END IF;

  -- 1.2 organization_id 必须指向真实存在的组织（否则第 4 步建外键必然失败）
  SELECT
      (SELECT count(*) FROM accounts         a WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = a.organization_id))
    + (SELECT count(*) FROM transactions    t WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = t.organization_id))
    + (SELECT count(*) FROM initial_holdings h WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = h.organization_id))
    + (SELECT count(*) FROM cost_lots        l WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = l.organization_id))
    + (SELECT count(*) FROM plans            p WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p.organization_id))
    + (SELECT count(*) FROM plan_change_logs c WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.organization_id))
    + (SELECT count(*) FROM usage_records    u WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = u.organization_id))
    + (SELECT count(*) FROM corrections      c WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.organization_id))
    + (SELECT count(*) FROM reminders        r WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = r.organization_id))
    + (SELECT count(*) FROM ai_conversations a WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = a.organization_id))
  INTO v_missing_org_rows;

  IF v_missing_org_rows <> 0 THEN
    RAISE EXCEPTION
      'MIG-E 中止：% 行的 organization_id 在 organizations 中无对应组织（孤儿租户行）',
      v_missing_org_rows;
  END IF;

  -- 1.3 派生行父子组织必须一致（技术方案 §5.3.2）
  SELECT
      (SELECT count(*) FROM usage_records u
         JOIN plans p ON p.id = u.plan_id
        WHERE u.organization_id IS DISTINCT FROM p.organization_id)
    + (SELECT count(*) FROM cost_lots l
         JOIN initial_holdings h ON l.source_type = 'INITIAL' AND h.id = l.source_id
        WHERE l.organization_id IS DISTINCT FROM h.organization_id)
    + (SELECT count(*) FROM cost_lots l
         JOIN transactions t ON l.source_type = 'PURCHASE' AND t.id = l.source_id
        WHERE l.organization_id IS DISTINCT FROM t.organization_id)
    + (SELECT count(*) FROM usage_lot_allocations x
         JOIN usage_records u ON u.id = x.usage_id
         JOIN cost_lots l ON l.id = x.lot_id
        WHERE u.organization_id IS DISTINCT FROM l.organization_id)
    + (SELECT count(*) FROM plan_change_logs c
         JOIN plans p ON p.id = c.plan_id
        WHERE c.organization_id IS DISTINCT FROM p.organization_id)
  INTO v_bad_parent_child;

  IF v_bad_parent_child <> 0 THEN
    RAISE EXCEPTION
      'MIG-E 中止：% 条派生行与其父记录 organization_id 不一致（跨组织父子挂载）',
      v_bad_parent_child;
  END IF;

  RAISE NOTICE 'MIG-E 预检通过：0 NULL / 0 孤儿租户 / 0 跨组织父子';
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2. organization_id SET NOT NULL（10 张业务表）
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "accounts"         ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "transactions"    ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "initial_holdings" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "cost_lots"        ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "plans"            ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "plan_change_logs" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "usage_records"    ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "corrections"      ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "reminders"        ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "ai_conversations" ALTER COLUMN "organization_id" SET NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 3. 清理过渡期部分唯一索引与冗余 (user_id, ...) 索引
--    （organization_id 已 NOT NULL，过渡期「NULL 行按 user 唯一」的部分索引不再需要）
-- ─────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "accounts_legacy_user_currency_uidx";
DROP INDEX IF EXISTS "initial_holdings_legacy_user_currency_uidx";
DROP INDEX IF EXISTS "reminders_legacy_user_dedup_scheduled_uidx";

DROP INDEX IF EXISTS "accounts_user_id_currency_code_idx";
DROP INDEX IF EXISTS "transactions_user_id_transacted_at_idx";
DROP INDEX IF EXISTS "initial_holdings_user_id_currency_code_idx";
DROP INDEX IF EXISTS "cost_lots_user_id_currency_code_acquired_at_created_at_idx";
DROP INDEX IF EXISTS "plans_user_id_status_idx";
DROP INDEX IF EXISTS "usage_records_user_id_used_at_idx";
DROP INDEX IF EXISTS "reminders_user_id_dedup_key_scheduled_for_idx";
DROP INDEX IF EXISTS "reminders_user_id_scheduled_for_idx";

-- ─────────────────────────────────────────────────────────────
-- 4. 作者列解绑 + 外键重建
-- ─────────────────────────────────────────────────────────────

-- 4.1 清理游离无效的 created_by_id / actor_user_id
--     （这些列此前无外键约束，可能残留已删除用户的 id；置 NULL 后再加 SET NULL 外键）
UPDATE "accounts"         SET "created_by_id" = NULL WHERE "created_by_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "accounts"."created_by_id");
UPDATE "transactions"    SET "created_by_id" = NULL WHERE "created_by_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "transactions"."created_by_id");
UPDATE "initial_holdings" SET "created_by_id" = NULL WHERE "created_by_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "initial_holdings"."created_by_id");
UPDATE "plans"            SET "created_by_id" = NULL WHERE "created_by_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "plans"."created_by_id");
UPDATE "usage_records"    SET "created_by_id" = NULL WHERE "created_by_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "usage_records"."created_by_id");
UPDATE "corrections"      SET "actor_user_id" = NULL WHERE "actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "corrections"."actor_user_id");
UPDATE "plan_change_logs" SET "actor_user_id" = NULL WHERE "actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = "plan_change_logs"."actor_user_id");

-- 4.2 删除 8 张共享账本表原有的 user_id 级联外键
--     （User → 账本表的 ON DELETE CASCADE 正是「个人注销误删企业账本」的根因）
ALTER TABLE "accounts"         DROP CONSTRAINT IF EXISTS "accounts_user_id_fkey";
ALTER TABLE "transactions"    DROP CONSTRAINT IF EXISTS "transactions_user_id_fkey";
ALTER TABLE "initial_holdings" DROP CONSTRAINT IF EXISTS "initial_holdings_user_id_fkey";
ALTER TABLE "cost_lots"        DROP CONSTRAINT IF EXISTS "cost_lots_user_id_fkey";
ALTER TABLE "plans"            DROP CONSTRAINT IF EXISTS "plans_user_id_fkey";
ALTER TABLE "usage_records"    DROP CONSTRAINT IF EXISTS "usage_records_user_id_fkey";
ALTER TABLE "corrections"      DROP CONSTRAINT IF EXISTS "corrections_user_id_fkey";
ALTER TABLE "reminders"        DROP CONSTRAINT IF EXISTS "reminders_user_id_fkey";

-- 4.3 账本表直连 Organization（ON DELETE RESTRICT）
--     组织删除必须走显式事务清理子表，不再依赖 User 级联（技术方案 §5.3 #5）
ALTER TABLE "accounts"         ADD CONSTRAINT "accounts_organization_id_fkey"         FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "transactions"    ADD CONSTRAINT "transactions_organization_id_fkey"    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "initial_holdings" ADD CONSTRAINT "initial_holdings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "cost_lots"        ADD CONSTRAINT "cost_lots_organization_id_fkey"        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "plans"            ADD CONSTRAINT "plans_organization_id_fkey"            FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "plan_change_logs" ADD CONSTRAINT "plan_change_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "usage_records"    ADD CONSTRAINT "usage_records_organization_id_fkey"    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "corrections"      ADD CONSTRAINT "corrections_organization_id_fkey"      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "reminders"        ADD CONSTRAINT "reminders_organization_id_fkey"        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
-- AI 会话随组织删除级联清理（会话本身是组织内资产）
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- 4.4 作者列改为 ON DELETE SET NULL（成员移除 / 用户注销不丢组织账本与历史）
ALTER TABLE "accounts"         ADD CONSTRAINT "accounts_created_by_id_fkey"         FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "transactions"    ADD CONSTRAINT "transactions_created_by_id_fkey"    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "initial_holdings" ADD CONSTRAINT "initial_holdings_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "plans"            ADD CONSTRAINT "plans_created_by_id_fkey"            FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "usage_records"    ADD CONSTRAINT "usage_records_created_by_id_fkey"    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "corrections"      ADD CONSTRAINT "corrections_actor_user_id_fkey"      FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "plan_change_logs" ADD CONSTRAINT "plan_change_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;
