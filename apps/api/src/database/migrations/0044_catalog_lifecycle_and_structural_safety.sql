GRANT UPDATE (status, version, updated_at), DELETE ON catalog_categories TO uco_app;
GRANT UPDATE (status, type, track_inventory, base_unit, version, updated_at), DELETE ON catalog_items TO uco_app;

CREATE FUNCTION prevent_catalog_item_structural_mutation_with_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.type IS DISTINCT FROM OLD.type OR
      NEW.track_inventory IS DISTINCT FROM OLD.track_inventory OR
      NEW.base_unit IS DISTINCT FROM OLD.base_unit) THEN
    IF EXISTS (
      SELECT 1 FROM resource_history_references
      WHERE organization_id = NEW.organization_id AND catalog_item_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'catalog item structural change blocked by history' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION prevent_catalog_item_structural_mutation_with_history() FROM PUBLIC;
CREATE TRIGGER catalog_items_structural_history_protected
  BEFORE UPDATE ON catalog_items
  FOR EACH ROW
  EXECUTE FUNCTION prevent_catalog_item_structural_mutation_with_history();
