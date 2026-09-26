CREATE FUNCTION initialize_branch_stocks() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO branch_stocks (organization_id, branch_id, item_id)
  SELECT NEW.organization_id, NEW.id, i.id FROM catalog_items i
  WHERE i.organization_id = NEW.organization_id AND i.type = 'PRODUCT' AND i.track_inventory;
  RETURN NEW;
END;
$$;
CREATE TRIGGER branches_initialize_stocks AFTER INSERT ON branches
  FOR EACH ROW EXECUTE FUNCTION initialize_branch_stocks();
