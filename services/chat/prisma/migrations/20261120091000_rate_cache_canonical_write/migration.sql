BEGIN;

ALTER TABLE "exchange_rates" ADD COLUMN "canonical_write_id" UUID;

-- A writer must supply a new token for each canonical write, including a
-- same-value refresh. An older writer cannot inherit the current proof.
CREATE FUNCTION clear_rate_cache_canonical_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.canonical_write_id := NULL;
    RETURN NEW;
END;
$$;

CREATE TRIGGER clear_rate_cache_canonical_write
BEFORE UPDATE ON "exchange_rates"
FOR EACH ROW
WHEN (
    OLD.canonical_write_id IS NOT NULL AND
    NEW.canonical_write_id = OLD.canonical_write_id
)
EXECUTE FUNCTION clear_rate_cache_canonical_write();

COMMIT;
