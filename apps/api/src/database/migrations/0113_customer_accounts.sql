CREATE TABLE customer_accounts (
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  balance numeric(20,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  credit_limit numeric(20,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organization_id, customer_id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE customer_account_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  cash_session_id uuid NOT NULL,
  device_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('SALE','COLLECTION','SALE_CANCELLATION','COLLECTION_REVERSAL')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  delta numeric(20,2) NOT NULL,
  balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  method text CHECK (method IN ('CASH','DEBIT_CARD','CREDIT_CARD','TRANSFER','QR')),
  sale_id uuid,
  original_entry_id uuid,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, customer_id, id),
  UNIQUE (organization_id, kind, sale_id),
  UNIQUE (organization_id, kind, original_entry_id),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customer_accounts (organization_id, customer_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, branch_id, cash_session_id, device_id)
    REFERENCES cash_sessions (organization_id, branch_id, id, device_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, sale_id) REFERENCES sales (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, customer_id, original_entry_id)
    REFERENCES customer_account_entries (organization_id, customer_id, id) ON DELETE RESTRICT,
  CHECK ((kind IN ('SALE','COLLECTION_REVERSAL') AND delta = amount)
    OR (kind IN ('COLLECTION','SALE_CANCELLATION') AND delta = -amount)),
  CHECK ((kind='SALE' AND sale_id IS NOT NULL AND original_entry_id IS NULL AND method IS NULL)
    OR (kind='SALE_CANCELLATION' AND sale_id IS NOT NULL AND original_entry_id IS NOT NULL AND method IS NULL)
    OR (kind='COLLECTION' AND sale_id IS NULL AND original_entry_id IS NULL AND method IS NOT NULL)
    OR (kind='COLLECTION_REVERSAL' AND sale_id IS NULL AND original_entry_id IS NOT NULL AND method IS NOT NULL)),
  CHECK (kind <> 'COLLECTION_REVERSAL' OR length(btrim(reason)) BETWEEN 1 AND 500)
);
CREATE INDEX customer_account_entries_history ON customer_account_entries
  (organization_id, customer_id, occurred_at DESC, id DESC);

ALTER TABLE customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_account_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_accounts_tenant ON customer_accounts FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
CREATE POLICY customer_account_entries_tenant ON customer_account_entries FOR ALL TO uco_app
  USING (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id',true),'')::uuid);
GRANT SELECT, INSERT (organization_id,customer_id), UPDATE (credit_limit,version), DELETE ON customer_accounts TO uco_app;
GRANT SELECT, INSERT ON customer_account_entries TO uco_app;

CREATE FUNCTION validate_customer_account_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.credit_limit <> OLD.credit_limit AND NEW.credit_limit < NEW.balance THEN
    RAISE EXCEPTION 'limit below account balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_account_limit BEFORE UPDATE ON customer_accounts
  FOR EACH ROW EXECUTE FUNCTION validate_customer_account_limit();

CREATE FUNCTION apply_customer_account_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE account public.customer_accounts%ROWTYPE;
DECLARE original public.customer_account_entries%ROWTYPE;
DECLARE sale public.sales%ROWTYPE;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM nullif(current_setting('app.organization_id',true),'')::uuid
    OR NEW.actor_user_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid THEN
    RAISE EXCEPTION 'account context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT * INTO account FROM public.customer_accounts
    WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id FOR UPDATE;
  IF account.customer_id IS NULL OR account.balance + NEW.delta < 0
    OR (NEW.kind='SALE' AND account.balance + NEW.amount > account.credit_limit) THEN
    RAISE EXCEPTION 'invalid account balance or limit' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=NEW.organization_id AND base_currency=NEW.currency_code) THEN
    RAISE EXCEPTION 'account currency mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.original_entry_id IS NOT NULL THEN
    SELECT * INTO original FROM public.customer_account_entries WHERE organization_id=NEW.organization_id
      AND customer_id=NEW.customer_id AND id=NEW.original_entry_id;
    IF original.id IS NULL OR original.amount<>NEW.amount OR original.currency_code<>NEW.currency_code
      OR original.branch_id<>NEW.branch_id
      OR (NEW.kind='COLLECTION_REVERSAL' AND (original.kind<>'COLLECTION' OR original.method<>NEW.method))
      OR (NEW.kind='SALE_CANCELLATION' AND (original.kind<>'SALE' OR original.sale_id<>NEW.sale_id)) THEN
      RAISE EXCEPTION 'invalid account compensation' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.kind='SALE' THEN
    SELECT * INTO sale FROM public.sales WHERE organization_id=NEW.organization_id AND id=NEW.sale_id;
    IF sale.customer_id IS DISTINCT FROM NEW.customer_id OR sale.branch_id IS DISTINCT FROM NEW.branch_id
      OR sale.cash_session_id IS DISTINCT FROM NEW.cash_session_id
      OR sale.currency_code IS DISTINCT FROM NEW.currency_code OR NEW.amount>sale.total THEN
      RAISE EXCEPTION 'invalid account sale reference' USING ERRCODE='23514';
    END IF;
  END IF;
  NEW.balance_after := account.balance + NEW.delta;
  UPDATE public.customer_accounts SET balance=NEW.balance_after,version=version+1
    WHERE organization_id=NEW.organization_id AND customer_id=NEW.customer_id;
  INSERT INTO public.customer_history_references (id,organization_id,customer_id,reference_type,source_id)
    VALUES (NEW.id,NEW.organization_id,NEW.customer_id,'ACCOUNT_ENTRY',NEW.id);
  INSERT INTO public.organization_history_references (id,organization_id,reference_domain,reference_type,source_id)
    VALUES (NEW.id,NEW.organization_id,'MONETARY','CUSTOMER_ACCOUNT_ENTRY',NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION apply_customer_account_entry() FROM PUBLIC;
CREATE TRIGGER customer_account_entry_projection BEFORE INSERT ON customer_account_entries
  FOR EACH ROW EXECUTE FUNCTION apply_customer_account_entry();
CREATE TRIGGER customer_account_entries_immutable BEFORE UPDATE OR DELETE ON customer_account_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_cash_movement_mutation();
