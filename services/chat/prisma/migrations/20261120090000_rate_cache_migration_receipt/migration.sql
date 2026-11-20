BEGIN;

CREATE TABLE "rate_cache_migration_receipts" (
    "id" UUID NOT NULL,
    "scope_checksum" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolled_back_at" TIMESTAMP(3),

    CONSTRAINT "rate_cache_migration_receipts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "exchange_rates" ADD COLUMN "migration_owner_id" UUID;

-- Any later ordinary UPDATE supersedes the migration's row version, even
-- when an upsert writes the same business values. The CLI only claims
-- unowned rows and restores owned rows with a NULL marker.
CREATE FUNCTION clear_rate_cache_migration_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.migration_owner_id := NULL;
    RETURN NEW;
END;
$$;

CREATE TRIGGER clear_rate_cache_migration_owner
BEFORE UPDATE ON "exchange_rates"
FOR EACH ROW
WHEN (OLD.migration_owner_id IS NOT NULL)
EXECUTE FUNCTION clear_rate_cache_migration_owner();

COMMIT;
