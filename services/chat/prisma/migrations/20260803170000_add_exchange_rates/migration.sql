-- DropTable
DROP TABLE "projects";

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(20, 10) NOT NULL,
    "source" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_quote_observed_at_key" ON "exchange_rates" (
    "base", "quote", "observed_at"
);

-- CreateIndex
CREATE INDEX "exchange_rates_base_quote_observed_at_idx" ON "exchange_rates" (
    "base", "quote", "observed_at"
);
