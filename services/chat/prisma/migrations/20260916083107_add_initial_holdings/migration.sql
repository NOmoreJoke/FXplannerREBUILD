-- CreateTable
CREATE TABLE "initial_holdings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "currency_code" TEXT NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "raw_rate" DECIMAL(20,10) NOT NULL,
    "rate_source" TEXT NOT NULL,
    "rate_observed_at" TIMESTAMP(3) NOT NULL,
    "cost" DECIMAL(20,4) NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "initial_holdings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "initial_holdings_user_id_currency_code_key" ON "initial_holdings"("user_id", "currency_code");

-- AddForeignKey
ALTER TABLE "initial_holdings" ADD CONSTRAINT "initial_holdings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
