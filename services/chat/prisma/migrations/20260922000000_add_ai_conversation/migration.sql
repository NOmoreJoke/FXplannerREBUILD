-- AI 助手（changes/ai-assistant/技术方案.md §3.2）：新增 ai_conversations / ai_messages
-- 两张表（纯新增，对存量表零改动；回滚仅需停 AI_CHAT_ENABLED 开关，无需回滚 DDL）。
-- 索引：会话列表按用户倒序（idx_user_updated）；消息按会话时序读（idx_conversation_created）。
-- 注：非交互环境由 `prisma migrate diff --from-schema-datamodel --to-schema-datamodel` 生成。
-- 回滚：
--   DROP TABLE "ai_messages";
--   DROP TABLE "ai_conversations";

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_user_updated" ON "ai_conversations"("user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_conversation_created" ON "ai_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
