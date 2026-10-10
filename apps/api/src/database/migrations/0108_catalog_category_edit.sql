-- RF-221: allow the runtime to rename categories under the existing tenant RLS.
-- Identity, organization ownership and historical references remain protected.
GRANT UPDATE (name) ON catalog_categories TO uco_app;

-- A new tracked product has empty stock projections even before its first
-- operation. Delete only those projections when deleting the unused master;
-- historical movement FKs remain RESTRICT and abort the entire transaction.
CREATE FUNCTION cleanup_unused_catalog_item_stocks() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM branch_stocks
    WHERE organization_id = OLD.organization_id AND item_id = OLD.id
    ORDER BY branch_id, item_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM branch_stocks WHERE organization_id = OLD.organization_id
    AND item_id = OLD.id AND quantity <> 0) THEN
    RAISE EXCEPTION 'catalog item has stock' USING ERRCODE = '55000';
  END IF;
  DELETE FROM branch_stocks WHERE organization_id = OLD.organization_id AND item_id = OLD.id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION cleanup_unused_catalog_item_stocks() FROM PUBLIC;
CREATE TRIGGER catalog_items_cleanup_unused_stocks BEFORE DELETE ON catalog_items
FOR EACH ROW EXECUTE FUNCTION cleanup_unused_catalog_item_stocks();
