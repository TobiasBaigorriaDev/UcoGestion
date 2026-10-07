-- All stock-changing ports insert their ledger entries before updating the
-- projection. Link only positive entries created by THIS transaction.
CREATE FUNCTION inventory_api.link_incident_corrections() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_incident uuid;
BEGIN
 IF NEW.quantity<=OLD.quantity THEN RETURN NEW; END IF;
 SELECT id INTO v_incident FROM inventory_incidents WHERE organization_id=NEW.organization_id
 AND branch_id=NEW.branch_id AND item_id=NEW.item_id AND status<>'RESOLVED' FOR UPDATE;
 IF v_incident IS NULL THEN RETURN NEW; END IF;
 INSERT INTO inventory_incident_corrections (organization_id,incident_id,movement_id)
 SELECT NEW.organization_id,v_incident,id FROM inventory_movements
 WHERE organization_id=NEW.organization_id AND branch_id=NEW.branch_id AND item_id=NEW.item_id
 AND delta>0 AND xmin=pg_current_xact_id()::text::xid
 ON CONFLICT DO NOTHING;
 IF NEW.quantity>=0 THEN
  UPDATE inventory_incidents SET status='PENDING_REVIEW' WHERE organization_id=NEW.organization_id AND id=v_incident;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.link_incident_corrections() FROM PUBLIC;
CREATE TRIGGER branch_stocks_incident_corrections AFTER UPDATE ON branch_stocks
 FOR EACH ROW EXECUTE FUNCTION inventory_api.link_incident_corrections();
