CREATE TABLE resource_history_references (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  catalog_item_id uuid,
  catalog_category_id uuid,
  branch_id uuid,
  cash_register_id uuid,
  payment_method text,
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 80),
  source_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_history_references_one_target_check CHECK (
    num_nonnulls(catalog_item_id, catalog_category_id, branch_id, cash_register_id, payment_method) = 1
  ),
  CONSTRAINT resource_history_references_catalog_item_fk FOREIGN KEY (organization_id, catalog_item_id)
    REFERENCES catalog_items (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT resource_history_references_catalog_category_fk FOREIGN KEY (organization_id, catalog_category_id)
    REFERENCES catalog_categories (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT resource_history_references_branch_fk FOREIGN KEY (organization_id, branch_id)
    REFERENCES branches (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT resource_history_references_cash_register_fk FOREIGN KEY (organization_id, cash_register_id)
    REFERENCES cash_registers (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT resource_history_references_payment_method_fk FOREIGN KEY (organization_id, payment_method)
    REFERENCES payment_method_settings (organization_id, method) ON DELETE RESTRICT
);

CREATE TABLE unrecoverable_device_declarations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  device_id uuid NOT NULL,
  declared_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  possible_unknown_history boolean NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unrecoverable_device_declarations_device_fk FOREIGN KEY (organization_id, device_id)
    REFERENCES devices (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT unrecoverable_device_declarations_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT unrecoverable_device_declarations_request_key UNIQUE (organization_id, device_id, request_id)
);

ALTER TABLE organizations
  ADD COLUMN currency_permanently_locked_at timestamptz,
  ADD COLUMN currency_lock_declaration_id uuid,
  ADD CONSTRAINT organizations_currency_lock_declaration_fk
    FOREIGN KEY (id, currency_lock_declaration_id)
    REFERENCES unrecoverable_device_declarations (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT organizations_currency_lock_pair_check CHECK (
    (currency_permanently_locked_at IS NULL) = (currency_lock_declaration_id IS NULL)
  );

ALTER TABLE resource_history_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE unrecoverable_device_declarations ENABLE ROW LEVEL SECURITY;
CREATE POLICY resource_history_references_tenant_isolation ON resource_history_references FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY unrecoverable_device_declarations_tenant_isolation ON unrecoverable_device_declarations FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

GRANT SELECT, INSERT ON resource_history_references, unrecoverable_device_declarations TO uco_app;
GRANT UPDATE (status) ON devices TO uco_app;

CREATE TRIGGER resource_history_references_immutable
  BEFORE UPDATE OR DELETE ON resource_history_references FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();
CREATE TRIGGER resource_history_references_mark_organization_history
  AFTER INSERT ON resource_history_references FOR EACH ROW
  EXECUTE FUNCTION mark_organization_operational_history();
CREATE TRIGGER unrecoverable_device_declarations_immutable
  BEFORE UPDATE OR DELETE ON unrecoverable_device_declarations FOR EACH ROW
  EXECUTE FUNCTION prevent_offline_version_or_resource_mutation();

CREATE FUNCTION lock_currency_after_unrecoverable_declaration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.possible_unknown_history THEN
    UPDATE public.organizations
    SET currency_permanently_locked_at = COALESCE(currency_permanently_locked_at, NEW.declared_at),
        currency_lock_declaration_id = COALESCE(currency_lock_declaration_id, NEW.id)
    WHERE id = NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION lock_currency_after_unrecoverable_declaration() FROM PUBLIC;
CREATE TRIGGER unrecoverable_declaration_locks_currency
  AFTER INSERT ON unrecoverable_device_declarations FOR EACH ROW
  EXECUTE FUNCTION lock_currency_after_unrecoverable_declaration();

CREATE FUNCTION prevent_permanent_currency_unlock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.currency_permanently_locked_at IS NOT NULL AND (
    NEW.currency_permanently_locked_at IS DISTINCT FROM OLD.currency_permanently_locked_at OR
    NEW.currency_lock_declaration_id IS DISTINCT FROM OLD.currency_lock_declaration_id
  ) THEN
    RAISE EXCEPTION 'permanent currency lock cannot be removed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION prevent_permanent_currency_unlock() FROM PUBLIC;
CREATE TRIGGER organizations_permanent_currency_lock
  BEFORE UPDATE ON organizations FOR EACH ROW
  EXECUTE FUNCTION prevent_permanent_currency_unlock();
