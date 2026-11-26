-- ToB R1 · Goal #3B W26：DataRequest 个人/组织双域拆分的数据库约束（技术方案 §9.1）。
--
-- 同一事务内先无损规范化历史行，再加 CHECK：
-- 1) 持有「type = 'CLEAR' AND organization_id IS NULL」且尚无默认组织的用户，
--    补建默认组织 + OWNER/ACTIVE 成员关系 + 组织设置（口径同 MIG-B 回填）；
-- 2) 历史 CLEAR 一律映射为其默认组织的 ORGANIZATION 请求（状态机字段一律不动，
--    进行中的 PENDING 锁不解锁、不删除——§12.2.7「不允许突然解锁」）；
-- 3) 加 CHECK data_requests_scope_type_org_check。
--
-- 确定性组织 ID 必须是准 cuid 形态（^c[a-z0-9]{24}$）：OrganizationContextGuard /
-- BusinessOrgScopeGuard 以该正则校验 X-Organization-Id，带下划线等符号的 ID 会让
-- 这些用户永久 400。故用 'cdrmig' + md5 片段拼成 25 位；主键碰撞时 INSERT 直接失败
-- （fail-closed），绝不静默挂到既有组织。时间戳显式取 UTC（列类型为不带时区的
-- timestamp，与 Prisma 的 UTC 约定一致）；成员关系与组织同一 created_at，使
-- resolveDefaultOrganizationId 的「创建者」口径（组织首个成员且成员关系与组织同事务
-- 创建）成立。memberships / organization_settings 的幂等冲突一律 DO NOTHING。
-- 本文件只迁移「W26 之前」的存量形态；MIG-E/F（organization_id SET NOT NULL、
-- 去 User 级联）留给 Goal #3C。空库（shadow DB）上全部语句为零行，直接加约束。
-- 语句内不含分号（Prisma 迁移按分号切分语句），亦不使用 $$ 块。
BEGIN;

-- ── 1. 补建默认组织：尚无默认组织、但持有未挂组织历史 CLEAR 的用户 ──
WITH first_members AS (
	SELECT DISTINCT ON (m.organization_id)
		m.organization_id, m.user_id, m.joined_at, m.created_at, m.id
	FROM memberships m
	ORDER BY m.organization_id, m.created_at ASC, m.id ASC
),
defaults AS (
	SELECT DISTINCT ON (f.user_id) f.user_id, f.organization_id
	FROM first_members f
	JOIN organizations o ON o.id = f.organization_id
	WHERE f.created_at = o.created_at
	ORDER BY f.user_id, f.joined_at ASC, f.created_at ASC, f.id ASC
),
missing_users AS (
	SELECT DISTINCT dr.user_id
	FROM data_requests dr
	LEFT JOIN defaults d ON d.user_id = dr.user_id
	WHERE dr.type = 'CLEAR'
		AND dr.organization_id IS NULL
		AND d.organization_id IS NULL
)
INSERT INTO organizations (id, name, created_at, updated_at)
SELECT
	'cdrmig' || substr(md5(mu.user_id), 1, 19),
	-- 组织名同 MIG-B 的 defaultOrganizationName：姓名 → 邮箱前缀 → 「我的」
	COALESCE(
		NULLIF(btrim(u.name), ''),
		NULLIF(btrim(split_part(COALESCE(u.email, ''), '@', 1)), ''),
		'我的'
	) || '的工作台',
	timezone('UTC', now()),
	timezone('UTC', now())
FROM missing_users mu
JOIN users u ON u.id = mu.user_id
ORDER BY mu.user_id;

-- ── 2. OWNER / ACTIVE 成员关系：created_at 与组织同事务同一值 ──
-- 第 1 步落库后这些用户已有默认组织，missing_users 重算为空集；
-- 故按确定性 ID 关联「本迁移为其建组织的用户」（此时其历史 CLEAR 尚未挂组织）。
INSERT INTO memberships (id, organization_id, user_id, role, status, joined_at, created_at, updated_at)
SELECT
	'cdrmig' || substr(md5('membership:' || legacy.user_id), 1, 19),
	o.id,
	legacy.user_id,
	'OWNER',
	'ACTIVE',
	o.created_at,
	o.created_at,
	o.created_at
FROM (
	SELECT DISTINCT dr.user_id
	FROM data_requests dr
	WHERE dr.type = 'CLEAR' AND dr.organization_id IS NULL
) legacy
JOIN organizations o
	ON o.id = 'cdrmig' || substr(md5(legacy.user_id), 1, 19)
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- ── 3. 组织设置：仅复制非空 base_currency 的个人设置（同 MIG-B §12.2.3，不虚构本位币）──
INSERT INTO organization_settings (id, organization_id, base_currency, prep_preference, reminder_enabled, ledger_started_at, created_at, updated_at)
SELECT
	'cdrmig' || substr(md5('settings:' || o.id), 1, 19),
	o.id,
	s.base_currency,
	s.prep_preference,
	s.reminder_enabled,
	s.ledger_started_at,
	timezone('UTC', now()),
	timezone('UTC', now())
FROM (
	SELECT DISTINCT dr.user_id
	FROM data_requests dr
	WHERE dr.type = 'CLEAR' AND dr.organization_id IS NULL
) legacy
JOIN organizations o
	ON o.id = 'cdrmig' || substr(md5(legacy.user_id), 1, 19)
JOIN user_settings s ON s.user_id = legacy.user_id
WHERE COALESCE(btrim(s.base_currency), '') <> ''
ON CONFLICT (organization_id) DO NOTHING;

-- ── 4. DataRequest 语义映射（§12.2.7；只写 scope / organization_id，不触碰 updated_at）──
-- 未挂组织的 EXPORT / DELETION 一律为 PERSONAL（与 MIG-B 回填同口径）
UPDATE data_requests
SET scope = 'PERSONAL'
WHERE organization_id IS NULL
	AND type IN ('EXPORT', 'DELETION')
	AND scope <> 'PERSONAL';

-- 历史 CLEAR → 默认组织的 ORGANIZATION 请求（defaults 现已含第 1 步新建的组织）
WITH first_members AS (
	SELECT DISTINCT ON (m.organization_id)
		m.organization_id, m.user_id, m.joined_at, m.created_at, m.id
	FROM memberships m
	ORDER BY m.organization_id, m.created_at ASC, m.id ASC
),
defaults AS (
	SELECT DISTINCT ON (f.user_id) f.user_id, f.organization_id
	FROM first_members f
	JOIN organizations o ON o.id = f.organization_id
	WHERE f.created_at = o.created_at
	ORDER BY f.user_id, f.joined_at ASC, f.created_at ASC, f.id ASC
)
UPDATE data_requests dr
SET scope = 'ORGANIZATION', organization_id = d.organization_id
FROM defaults d
WHERE dr.organization_id IS NULL
	AND dr.type = 'CLEAR'
	AND d.user_id = dr.user_id;

-- 已挂组织的行一律为 ORGANIZATION
UPDATE data_requests
SET scope = 'ORGANIZATION'
WHERE organization_id IS NOT NULL
	AND scope <> 'ORGANIZATION';

-- ── 5. CHECK 约束：规范化后若仍有违约行，本语句失败、整个事务回滚（不删任何行）──
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_scope_type_org_check" CHECK (("scope" = 'PERSONAL' AND "type" IN ('EXPORT', 'DELETION') AND "organization_id" IS NULL) OR ("scope" = 'ORGANIZATION' AND "type" IN ('EXPORT', 'CLEAR', 'DELETION') AND "organization_id" IS NOT NULL));

COMMIT;
