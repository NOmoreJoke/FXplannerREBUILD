-- AlterTable
-- 资金使用备注（usage-recording 技术方案 §3.2：唯一 schema 增量，走冻结流程）。
-- 可空、无默认值，兼容存量（usage_records 在 M7 前为空表）；无外键/索引变更。
ALTER TABLE "usage_records" ADD COLUMN "remark" TEXT;
