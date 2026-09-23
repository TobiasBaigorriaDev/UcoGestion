ALTER TABLE configuration_versions
  ADD COLUMN config_epoch bigint NOT NULL DEFAULT 1 CHECK (config_epoch > 0);

CREATE TABLE catalog_item_identities (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  PRIMARY KEY (organization_id, id)
);

CREATE TABLE catalog_category_identities (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  PRIMARY KEY (organization_id, id)
);

INSERT INTO catalog_item_identities (organization_id, id)
  SELECT organization_id, id FROM catalog_items;
INSERT INTO catalog_category_identities (organization_id, id)
  SELECT organization_id, id FROM catalog_categories;

CREATE FUNCTION preserve_catalog_resource_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'catalog_items' THEN
    INSERT INTO public.catalog_item_identities (organization_id, id) VALUES (NEW.organization_id, NEW.id);
  ELSE
    INSERT INTO public.catalog_category_identities (organization_id, id) VALUES (NEW.organization_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION preserve_catalog_resource_identity() FROM PUBLIC;
CREATE TRIGGER catalog_item_identity_recorded AFTER INSERT ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION preserve_catalog_resource_identity();
CREATE TRIGGER catalog_category_identity_recorded AFTER INSERT ON catalog_categories
  FOR EACH ROW EXECUTE FUNCTION preserve_catalog_resource_identity();

ALTER TABLE offline_exposure_resources
  DROP CONSTRAINT offline_exposure_resources_catalog_item_fk,
  DROP CONSTRAINT offline_exposure_resources_catalog_category_fk,
  ADD CONSTRAINT offline_exposure_resources_catalog_item_fk
    FOREIGN KEY (organization_id, catalog_item_id)
    REFERENCES catalog_item_identities (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT offline_exposure_resources_catalog_category_fk
    FOREIGN KEY (organization_id, catalog_category_id)
    REFERENCES catalog_category_identities (organization_id, id) ON DELETE RESTRICT;

ALTER TABLE catalog_item_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_category_identities ENABLE ROW LEVEL SECURITY;
