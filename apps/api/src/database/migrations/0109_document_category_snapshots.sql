-- RF-269: optional current assignment; never infer historical assignments.
ALTER TABLE catalog_items ADD COLUMN category_id uuid;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_category_tenant_fk
  FOREIGN KEY (organization_id, category_id)
  REFERENCES catalog_categories (organization_id, id) ON DELETE RESTRICT;
GRANT INSERT (category_id) ON catalog_items TO uco_app;

-- UNKNOWN is metadata about missing evidence, not a reconstructed category.
ALTER TABLE sale_items ADD COLUMN category_snapshot_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE purchase_items ADD COLUMN category_snapshot_status text NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE sale_items ADD CONSTRAINT sale_items_category_snapshot_check CHECK (
  category_snapshot_status = 'UNKNOWN' OR
  (category_snapshot_status = 'NONE' AND category_id IS NULL AND category_name IS NULL) OR
  (category_snapshot_status = 'ASSIGNED' AND category_id IS NOT NULL AND category_name IS NOT NULL AND btrim(category_name) <> '')
);
ALTER TABLE purchase_items ADD CONSTRAINT purchase_items_category_snapshot_check CHECK (
  category_snapshot_status = 'UNKNOWN' OR
  (category_snapshot_status = 'NONE' AND category_id IS NULL AND category_name IS NULL) OR
  (category_snapshot_status = 'ASSIGNED' AND category_id IS NOT NULL AND category_name IS NOT NULL AND btrim(category_name) <> '')
);
ALTER TABLE sale_items ADD CONSTRAINT sale_items_category_tenant_fk
  FOREIGN KEY (organization_id, category_id)
  REFERENCES catalog_categories (organization_id, id) ON DELETE RESTRICT;
ALTER TABLE purchase_items ADD CONSTRAINT purchase_items_category_tenant_fk
  FOREIGN KEY (organization_id, category_id)
  REFERENCES catalog_categories (organization_id, id) ON DELETE RESTRICT;

-- Reference and snapshot are inseparable, including duplicate-category lines.
CREATE FUNCTION record_document_category_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category_id IS NOT NULL THEN
    INSERT INTO catalog_category_history_references (id, organization_id, category_id, reference_type, source_id)
    VALUES (gen_random_uuid(), NEW.organization_id, NEW.category_id,
      CASE WHEN TG_TABLE_NAME = 'sale_items' THEN 'SALE' ELSE 'PURCHASE' END,
      CASE WHEN TG_TABLE_NAME = 'sale_items' THEN (to_jsonb(NEW)->>'sale_id')::uuid
           ELSE (to_jsonb(NEW)->>'purchase_id')::uuid END)
    ON CONFLICT (organization_id, category_id, reference_type, source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION record_document_category_history() FROM PUBLIC;
CREATE TRIGGER sale_items_category_history AFTER INSERT ON sale_items
  FOR EACH ROW EXECUTE FUNCTION record_document_category_history();
CREATE TRIGGER purchase_items_category_history AFTER INSERT ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION record_document_category_history();
