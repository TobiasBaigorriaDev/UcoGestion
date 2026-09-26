CREATE FUNCTION initialize_item_stocks() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.type = 'PRODUCT' AND NEW.track_inventory THEN
    INSERT INTO branch_stocks (organization_id, branch_id, item_id)
    SELECT NEW.organization_id, b.id, NEW.id FROM branches b
    WHERE b.organization_id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_items_initialize_stocks AFTER INSERT ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION initialize_item_stocks();
