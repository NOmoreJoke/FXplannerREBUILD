-- M11 account-data（技术方案 §4）：DataRequest 加验证凭证绑定列与终态时间戳，
-- 并建 (userId, status) 索引（互斥查询 / 锁守卫查询 / 查当前请求共用）。
-- 回滚：
--   DROP INDEX "data_requests_user_id_status_idx";
--   DROP INDEX "data_requests_verified_challenge_id_key";
--   ALTER TABLE "data_requests" DROP COLUMN "processed_at";
--   ALTER TABLE "data_requests" DROP COLUMN "verified_challenge_id";

-- AlterTable
ALTER TABLE "data_requests" ADD COLUMN "verified_challenge_id" TEXT;
ALTER TABLE "data_requests" ADD COLUMN "processed_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "data_requests_user_id_status_idx" ON "data_requests" (
    "user_id", "status"
);

-- CreateIndex
CREATE UNIQUE INDEX "data_requests_verified_challenge_id_key" ON "data_requests" (
    "verified_challenge_id"
);
