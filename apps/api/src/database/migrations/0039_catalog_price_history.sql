ALTER TABLE catalog_items
  ADD COLUMN price numeric(20,2),
  ADD COLUMN price_version bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT catalog_items_price_state_check CHECK (
    (price IS NULL AND price_version = 0) OR
    (price >= 0 AND price_version > 0)
  );

CREATE TABLE catalog_price_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  item_id uuid NOT NULL,
  price_version bigint NOT NULL CHECK (price_version > 0),
  price numeric(20,2) NOT NULL CHECK (price >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_price_versions_item_fk FOREIGN KEY (organization_id, item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT catalog_price_versions_item_version_key UNIQUE (organization_id, item_id, price_version)
);

ALTER TABLE catalog_price_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_price_versions_tenant_isolation ON catalog_price_versions
  FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE FUNCTION prevent_catalog_price_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'catalog price versions are append-only' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION prevent_catalog_price_version_mutation() FROM PUBLIC;
CREATE TRIGGER catalog_price_versions_immutable
  BEFORE UPDATE OR DELETE ON catalog_price_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_catalog_price_version_mutation();

CREATE FUNCTION check_catalog_item_price_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price IS DISTINCT FROM OLD.price OR NEW.price_version IS DISTINCT FROM OLD.price_version THEN
    IF NEW.price IS NULL OR NEW.price_version <> OLD.price_version + 1 OR NEW.version <> OLD.version + 1
       OR NOT EXISTS (
         SELECT 1 FROM catalog_price_versions
         WHERE organization_id = NEW.organization_id AND item_id = NEW.id
           AND price_version = NEW.price_version AND price = NEW.price
       ) THEN
      RAISE EXCEPTION 'catalog price change requires a matching immutable version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION check_catalog_item_price_change() FROM PUBLIC;
CREATE TRIGGER catalog_item_price_change_checked
  BEFORE UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION check_catalog_item_price_change();

GRANT UPDATE (price, price_version, version, updated_at) ON catalog_items TO uco_app;
GRANT SELECT, INSERT ON catalog_price_versions TO uco_app;
