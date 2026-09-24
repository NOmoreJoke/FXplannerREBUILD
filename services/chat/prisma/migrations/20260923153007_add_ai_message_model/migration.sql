-- AI 多模型白名单（changes/ai-model-whitelist/技术方案.md §3.2）：ai_messages 加 model 列，
-- 记录 assistant 消息所用的白名单 key（如 "gpt-4.1-mini"）；user 消息为 NULL，存量行为 NULL。
-- 纯可空加列，向后兼容（旧代码不读写该列），回滚仅需 DROP COLUMN，无数据回填。
-- 注：非交互环境由 `prisma migrate diff --from-schema-datamodel --to-schema-datamodel` 生成。
-- 回滚：
--   ALTER TABLE "ai_messages" DROP COLUMN "model";

-- AlterTable
ALTER TABLE "ai_messages" ADD COLUMN "model" TEXT;
