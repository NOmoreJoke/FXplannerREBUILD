-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "name" TEXT,
ADD COLUMN     "pace_preference" TEXT NOT NULL DEFAULT 'balanced';

-- CreateTable
CREATE TABLE "plan_installments" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "plan_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_installments_plan_id_scheduled_at_idx" ON "plan_installments"("plan_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "plan_installments_plan_id_seq_key" ON "plan_installments"("plan_id", "seq");

-- AddForeignKey
ALTER TABLE "plan_installments" ADD CONSTRAINT "plan_installments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
