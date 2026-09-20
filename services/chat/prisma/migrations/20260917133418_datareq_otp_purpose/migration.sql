-- M11 account-data（技术方案 §4）：OtpChallenge 加用途列，
-- 实现「登录、导出、清空、注销分别验证，互相不能顶用」。
-- 回滚：ALTER TABLE "otp_challenges" DROP COLUMN "purpose";

-- AlterTable
ALTER TABLE "otp_challenges" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'LOGIN';
