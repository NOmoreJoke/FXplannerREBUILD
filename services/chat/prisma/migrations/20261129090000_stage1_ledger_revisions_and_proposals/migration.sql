-- Stage 1 W40：LedgerRevision 单调修订号触发器、AgentProposal 8 态表、ai_messages.resolved_slots 及存量 LEGACY 回填
-- 上游真源：changes/product-harness-agent/技术方案.md §2.1 & docs/handoff/GOAL-7-STAGE1-HARNESS-PROPOSAL-ZHIHE-20261128.md

-- ── 1. 新增表：ledger_revisions ──
CREATE TABLE "ledger_revisions" (
    "organization_id" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_revisions_pkey" PRIMARY KEY ("organization_id","currency_code")
);

ALTER TABLE "ledger_revisions"
    ADD CONSTRAINT "ledger_revisions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. 新增表：agent_proposals ──
-- 个人注销零级联红线：created_by_id / confirmed_by_id / conversation_id / message_id 全部可空且 ON DELETE SET NULL
CREATE TABLE "agent_proposals" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "agent_run_id" TEXT,
    "created_by_id" TEXT,
    "confirmed_by_id" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invalid_reason" TEXT,
    "supersede_key" TEXT,
    "input_payload" JSONB NOT NULL,
    "preview_snapshot" JSONB NOT NULL,
    "base_revisions" JSONB NOT NULL,
    "target_version" INTEGER,
    "quote_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "committed_target_type" TEXT,
    "committed_target_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_proposals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_proposals_kind_check" CHECK ("kind" IN ('PLAN_CREATE', 'PLAN_ADJUST', 'TX_BUY', 'USAGE_RECORD', 'CORRECTION_APPLY')),
    CONSTRAINT "agent_proposals_status_check" CHECK ("status" IN ('PENDING', 'STALE', 'CONFIRMED', 'DISMISSED', 'EXPIRED', 'SUPERSEDED', 'INVALIDATED', 'LEGACY'))
);

CREATE INDEX "agent_proposals_organization_id_created_by_id_status_created__idx"
    ON "agent_proposals"("organization_id", "created_by_id", "status", "created_at" DESC);
CREATE INDEX "agent_proposals_organization_id_conversation_id_created_at_idx"
    ON "agent_proposals"("organization_id", "conversation_id", "created_at" DESC);
CREATE INDEX "agent_proposals_organization_id_supersede_key_status_idx"
    ON "agent_proposals"("organization_id", "supersede_key", "status");
CREATE INDEX "agent_proposals_message_id_idx"
    ON "agent_proposals"("message_id");

ALTER TABLE "agent_proposals"
    ADD CONSTRAINT "agent_proposals_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_proposals"
    ADD CONSTRAINT "agent_proposals_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_proposals"
    ADD CONSTRAINT "agent_proposals_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_proposals"
    ADD CONSTRAINT "agent_proposals_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_proposals"
    ADD CONSTRAINT "agent_proposals_confirmed_by_id_fkey"
    FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. ai_messages 新增冻结槽位载荷列 ──
ALTER TABLE "ai_messages" ADD COLUMN "resolved_slots" JSONB;

-- ── 4. 语句级触发器（6+1 张账本表 → ledger_revisions 单调递增） ──
-- 注意：
-- 1) 对同一批受影响行按 (organization_id, currency_code) 去重并升序排序 upsert，防止单语句多次命中与并发死锁；
-- 2) INNER JOIN organizations 防止删除组织级联清理时反向往已删组织插入 ledger_revisions 触发外键错；
-- 3) UPDATE 若变更币种，同时递增旧币种与新币种。

CREATE OR REPLACE FUNCTION "bump_ledger_revision_from_currency_table"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT DISTINCT d."organization_id", d."currency_code", 1, CURRENT_TIMESTAMP
        FROM "new_rows" d
        INNER JOIN "organizations" o ON o."id" = d."organization_id"
        WHERE d."organization_id" IS NOT NULL AND d."currency_code" IS NOT NULL
        ORDER BY d."organization_id", d."currency_code"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT d."organization_id", d."currency_code", 1, CURRENT_TIMESTAMP
        FROM (
            SELECT "organization_id", "currency_code" FROM "old_rows"
            UNION
            SELECT "organization_id", "currency_code" FROM "new_rows"
        ) d
        INNER JOIN "organizations" o ON o."id" = d."organization_id"
        WHERE d."organization_id" IS NOT NULL AND d."currency_code" IS NOT NULL
        ORDER BY d."organization_id", d."currency_code"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT DISTINCT d."organization_id", d."currency_code", 1, CURRENT_TIMESTAMP
        FROM "old_rows" d
        INNER JOIN "organizations" o ON o."id" = d."organization_id"
        WHERE d."organization_id" IS NOT NULL AND d."currency_code" IS NOT NULL
        ORDER BY d."organization_id", d."currency_code"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "bump_ledger_revision_from_plans"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT DISTINCT d."organization_id", d."target_currency", 1, CURRENT_TIMESTAMP
        FROM "new_rows" d
        INNER JOIN "organizations" o ON o."id" = d."organization_id"
        WHERE d."organization_id" IS NOT NULL AND d."target_currency" IS NOT NULL
        ORDER BY d."organization_id", d."target_currency"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT d."organization_id", d."target_currency", 1, CURRENT_TIMESTAMP
        FROM (
            SELECT "organization_id", "target_currency" FROM "old_rows"
            UNION
            SELECT "organization_id", "target_currency" FROM "new_rows"
        ) d
        INNER JOIN "organizations" o ON o."id" = d."organization_id"
        WHERE d."organization_id" IS NOT NULL AND d."target_currency" IS NOT NULL
        ORDER BY d."organization_id", d."target_currency"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT DISTINCT d."organization_id", d."target_currency", 1, CURRENT_TIMESTAMP
        FROM "old_rows" d
        INNER JOIN "organizations" o ON o."id" = d."organization_id"
        WHERE d."organization_id" IS NOT NULL AND d."target_currency" IS NOT NULL
        ORDER BY d."organization_id", d."target_currency"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "bump_ledger_revision_from_plan_allocations"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT DISTINCT p."organization_id", p."target_currency", 1, CURRENT_TIMESTAMP
        FROM "new_rows" d
        INNER JOIN "plans" p ON p."id" = d."plan_id"
        INNER JOIN "organizations" o ON o."id" = p."organization_id"
        ORDER BY p."organization_id", p."target_currency"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO "ledger_revisions" ("organization_id", "currency_code", "revision", "updated_at")
        SELECT DISTINCT p."organization_id", p."target_currency", 1, CURRENT_TIMESTAMP
        FROM (
            SELECT "plan_id" FROM "old_rows"
            UNION
            SELECT "plan_id" FROM "new_rows"
        ) d
        INNER JOIN "plans" p ON p."id" = d."plan_id"
        INNER JOIN "organizations" o ON o."id" = p."organization_id"
        ORDER BY p."organization_id", p."target_currency"
        ON CONFLICT ("organization_id", "currency_code")
        DO UPDATE SET
            "revision" = "ledger_revisions"."revision" + 1,
            "updated_at" = CURRENT_TIMESTAMP;
    END IF;
    RETURN NULL;
END;
$$;

-- 5 张直接含 (organization_id, currency_code) 的主表
CREATE TRIGGER "accounts_ledger_revision_ins_trg"
    AFTER INSERT ON "accounts"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "accounts_ledger_revision_upd_trg"
    AFTER UPDATE ON "accounts"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "accounts_ledger_revision_del_trg"
    AFTER DELETE ON "accounts"
    REFERENCING OLD TABLE AS "old_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();

CREATE TRIGGER "transactions_ledger_revision_ins_trg"
    AFTER INSERT ON "transactions"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "transactions_ledger_revision_upd_trg"
    AFTER UPDATE ON "transactions"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "transactions_ledger_revision_del_trg"
    AFTER DELETE ON "transactions"
    REFERENCING OLD TABLE AS "old_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();

CREATE TRIGGER "initial_holdings_ledger_revision_ins_trg"
    AFTER INSERT ON "initial_holdings"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "initial_holdings_ledger_revision_upd_trg"
    AFTER UPDATE ON "initial_holdings"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "initial_holdings_ledger_revision_del_trg"
    AFTER DELETE ON "initial_holdings"
    REFERENCING OLD TABLE AS "old_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();

CREATE TRIGGER "cost_lots_ledger_revision_ins_trg"
    AFTER INSERT ON "cost_lots"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "cost_lots_ledger_revision_upd_trg"
    AFTER UPDATE ON "cost_lots"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "cost_lots_ledger_revision_del_trg"
    AFTER DELETE ON "cost_lots"
    REFERENCING OLD TABLE AS "old_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();

CREATE TRIGGER "usage_records_ledger_revision_ins_trg"
    AFTER INSERT ON "usage_records"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "usage_records_ledger_revision_upd_trg"
    AFTER UPDATE ON "usage_records"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();
CREATE TRIGGER "usage_records_ledger_revision_del_trg"
    AFTER DELETE ON "usage_records"
    REFERENCING OLD TABLE AS "old_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_currency_table"();

-- plans（含 organization_id, target_currency）
CREATE TRIGGER "plans_ledger_revision_ins_trg"
    AFTER INSERT ON "plans"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_plans"();
CREATE TRIGGER "plans_ledger_revision_upd_trg"
    AFTER UPDATE ON "plans"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_plans"();
CREATE TRIGGER "plans_ledger_revision_del_trg"
    AFTER DELETE ON "plans"
    REFERENCING OLD TABLE AS "old_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_plans"();

-- plan_allocations（子表经 plan_id 关联 plans）
CREATE TRIGGER "plan_allocations_ledger_revision_ins_trg"
    AFTER INSERT ON "plan_allocations"
    REFERENCING NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_plan_allocations"();
CREATE TRIGGER "plan_allocations_ledger_revision_upd_trg"
    AFTER UPDATE ON "plan_allocations"
    REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
    FOR EACH STATEMENT EXECUTE FUNCTION "bump_ledger_revision_from_plan_allocations"();

-- ── 5. 存量 ai_messages.plan_draft 幂等回填为 LEGACY 只读提案 ──
INSERT INTO "agent_proposals" (
    "id",
    "organization_id",
    "conversation_id",
    "message_id",
    "agent_run_id",
    "created_by_id",
    "kind",
    "status",
    "input_payload",
    "preview_snapshot",
    "base_revisions",
    "expires_at",
    "created_at",
    "resolved_at"
)
SELECT
    'legacy_' || m."id",
    c."organization_id",
    m."conversation_id",
    m."id",
    NULLIF(m."plan_draft"->>'agentRunId', ''),
    c."user_id",
    'PLAN_CREATE',
    'LEGACY',
    m."plan_draft",
    m."plan_draft",
    '{}'::jsonb,
    m."created_at" + INTERVAL '24 hours',
    m."created_at",
    m."created_at"
FROM "ai_messages" m
INNER JOIN "ai_conversations" c ON c."id" = m."conversation_id"
WHERE m."plan_draft" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM "agent_proposals" ap WHERE ap."message_id" = m."id"
  );
