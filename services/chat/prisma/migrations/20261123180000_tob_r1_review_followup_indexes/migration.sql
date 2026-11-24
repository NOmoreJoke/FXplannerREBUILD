-- ToB R1 评审跟进索引（外部评审 N-09；Goal #3A 评审修复）
--
-- 1. reminder_reads(user_id)：唯一索引以 reminder_id 打头，服务不到「只按成员查已读态」
--    与用户注销时的外键级联删除（ON DELETE CASCADE 需按 user_id 定位子行）。
-- 2. ai_conversations(organization_id, last_message_at DESC)：既有两条索引均以 user_id
--    打头；MIG-B 后组织级导出/清空与按组织核对需要组织打头的访问路径。
--
-- 两张表均为小表（reminder_reads 随 MIG-B 首次产生数据），在事务内直接建索引即可；
-- 不使用 CONCURRENTLY（Prisma 迁移运行在事务内，不支持）。

-- Create index
CREATE INDEX "reminder_reads_user_id_idx" ON "reminder_reads"("user_id");

-- Create index
CREATE INDEX "ai_conversations_organization_id_last_message_at_idx" ON "ai_conversations"("organization_id", "last_message_at" DESC);
