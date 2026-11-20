-- Historical and latest writes both used created_at. Existing rows have no proof of latest confirmation.
ALTER TABLE "exchange_rates" ADD COLUMN "latest_confirmed_at" TIMESTAMP(3);
