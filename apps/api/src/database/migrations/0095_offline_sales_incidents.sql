ALTER TABLE sync_operations ADD CONSTRAINT sync_operations_org_id_key UNIQUE (organization_id,id);
ALTER TABLE sales ADD COLUMN offline_operation_id uuid, ADD COLUMN local_reference text,
 ADD COLUMN occurred_at timestamptz, ADD COLUMN received_at timestamptz,
 ADD CONSTRAINT sales_offline_operation_fk FOREIGN KEY (organization_id,offline_operation_id)
 REFERENCES sync_operations (organization_id,id) ON DELETE RESTRICT,
 ADD CONSTRAINT sales_offline_metadata_check CHECK ((offline_operation_id IS NULL AND local_reference IS NULL)
 OR (offline_operation_id IS NOT NULL AND local_reference IS NOT NULL AND occurred_at IS NOT NULL AND received_at IS NOT NULL));
ALTER TABLE sale_items ADD COLUMN track_inventory boolean;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_org_id_key UNIQUE (organization_id,id);
CREATE TABLE inventory_incidents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid NOT NULL, item_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('OPEN','PENDING_REVIEW','RESOLVED')),
 max_shortfall numeric(20,3) NOT NULL CHECK (max_shortfall>0),
 note text, resolved_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (organization_id,id),
 FOREIGN KEY (organization_id,branch_id,item_id) REFERENCES branch_stocks (organization_id,branch_id,item_id) ON DELETE RESTRICT,
 CHECK ((status='RESOLVED' AND btrim(note)<>'' AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL)
 OR (status<>'RESOLVED' AND note IS NULL AND resolved_by_user_id IS NULL AND resolved_at IS NULL))
);
CREATE UNIQUE INDEX inventory_incidents_one_active ON inventory_incidents (organization_id,branch_id,item_id) WHERE status<>'RESOLVED';
CREATE TABLE inventory_incident_sources (
 organization_id uuid NOT NULL, incident_id uuid NOT NULL, sale_id uuid NOT NULL, sale_item_id uuid NOT NULL,
 device_id uuid NOT NULL, stock_before numeric(20,3) NOT NULL,stock_after numeric(20,3) NOT NULL CHECK (stock_after<0),
 PRIMARY KEY (organization_id,sale_item_id),
 FOREIGN KEY (organization_id,incident_id) REFERENCES inventory_incidents (organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (organization_id,sale_id) REFERENCES sales (organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (organization_id,device_id) REFERENCES devices (organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE sale_items ADD CONSTRAINT sale_items_org_id_key UNIQUE (organization_id,id);
ALTER TABLE inventory_incident_sources ADD FOREIGN KEY (organization_id,sale_item_id) REFERENCES sale_items (organization_id,id) ON DELETE RESTRICT;
CREATE TABLE inventory_incident_corrections (
 organization_id uuid NOT NULL,incident_id uuid NOT NULL,movement_id uuid NOT NULL,
 PRIMARY KEY (organization_id,incident_id,movement_id),
 FOREIGN KEY (organization_id,incident_id) REFERENCES inventory_incidents (organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY (organization_id,movement_id) REFERENCES inventory_movements (organization_id,id) ON DELETE RESTRICT
);
ALTER TABLE inventory_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_incident_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_incident_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY inventory_incidents_tenant_isolation ON inventory_incidents FOR ALL TO uco_app
 USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY inventory_incident_sources_tenant_isolation ON inventory_incident_sources FOR ALL TO uco_app
 USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY inventory_incident_corrections_tenant_isolation ON inventory_incident_corrections FOR ALL TO uco_app
 USING (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid)
 WITH CHECK (organization_id=nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT ON inventory_incidents,inventory_incident_sources,inventory_incident_corrections TO uco_app;
GRANT UPDATE (status,note,resolved_by_user_id,resolved_at) ON inventory_incidents TO uco_app;
CREATE TRIGGER inventory_incident_sources_immutable BEFORE UPDATE OR DELETE ON inventory_incident_sources
 FOR EACH ROW EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
CREATE TRIGGER inventory_incident_corrections_immutable BEFORE UPDATE OR DELETE ON inventory_incident_corrections
 FOR EACH ROW EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();

CREATE FUNCTION inventory_api.lock_offline_sale_stock(p_org uuid,p_operation uuid,p_item uuid)
 RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_branch uuid;v_balance numeric;
BEGIN
 IF p_org IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid THEN
  RAISE EXCEPTION 'offline stock tenant mismatch' USING ERRCODE='42501'; END IF;
 SELECT a.branch_id INTO v_branch FROM sync_operations s
 JOIN offline_grant_authorizations a ON a.organization_id=s.organization_id AND a.grant_id=s.grant_id
 JOIN offline_grants g ON g.organization_id=s.organization_id AND g.id=s.grant_id
 JOIN configuration_versions v ON v.organization_id=g.organization_id AND v.version=g.configuration_version
 WHERE s.organization_id=p_org AND s.id=p_operation AND s.status='PENDING' AND s.kind='sale-confirm'
 AND a.actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.snapshot->'items') i WHERE i->>'id'=p_item::text AND (i->>'trackInventory')::boolean);
 IF v_branch IS NULL THEN RAISE EXCEPTION 'offline stock authorization invalid' USING ERRCODE='42501'; END IF;
 SELECT quantity INTO v_balance FROM branch_stocks WHERE organization_id=p_org AND branch_id=v_branch AND item_id=p_item FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'offline stock missing' USING ERRCODE='23503'; END IF;
 RETURN v_balance;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.lock_offline_sale_stock(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.lock_offline_sale_stock(uuid,uuid,uuid) TO uco_app;
CREATE FUNCTION inventory_api.apply_offline_sale_stock(p_org uuid,p_sale uuid,p_line uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_line record;v_before numeric;v_after numeric;v_incident uuid;
BEGIN
 SELECT si.*,s.branch_id,s.device_id,s.offline_operation_id INTO v_line FROM sale_items si
 JOIN sales s ON s.organization_id=si.organization_id AND s.id=si.sale_id
 WHERE si.organization_id=p_org AND si.id=p_line AND s.id=p_sale AND si.track_inventory
 AND s.actor_user_id=nullif(current_setting('app.user_id',true),'')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'offline stock line invalid' USING ERRCODE='42501'; END IF;
 v_before=inventory_api.lock_offline_sale_stock(p_org,v_line.offline_operation_id,v_line.item_id);
 INSERT INTO inventory_movements (id,organization_id,branch_id,item_id,actor_user_id,delta,source_type,source_id,source_line_id,effect_kind)
 VALUES (gen_random_uuid(),p_org,v_line.branch_id,v_line.item_id,nullif(current_setting('app.user_id',true),'')::uuid,-v_line.quantity,'SALE',p_sale,p_line,'DECREASE');
 v_after=v_before-v_line.quantity;
 UPDATE branch_stocks SET quantity=v_after,version=version+1 WHERE organization_id=p_org AND branch_id=v_line.branch_id AND item_id=v_line.item_id;
 IF v_after<0 THEN
  INSERT INTO inventory_incidents (id,organization_id,branch_id,item_id,status,max_shortfall)
   VALUES (gen_random_uuid(),p_org,v_line.branch_id,v_line.item_id,'OPEN',-v_after)
   ON CONFLICT (organization_id,branch_id,item_id) WHERE status<>'RESOLVED'
   DO UPDATE SET status='OPEN',max_shortfall=greatest(inventory_incidents.max_shortfall,EXCLUDED.max_shortfall)
   RETURNING id INTO v_incident;
  INSERT INTO inventory_incident_sources (organization_id,incident_id,sale_id,sale_item_id,device_id,stock_before,stock_after)
   VALUES (p_org,v_incident,p_sale,p_line,v_line.device_id,v_before,v_after);
 END IF;
 RETURN v_incident;
END;
$$;
REVOKE ALL ON FUNCTION inventory_api.apply_offline_sale_stock(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory_api.apply_offline_sale_stock(uuid,uuid,uuid) TO uco_app;
