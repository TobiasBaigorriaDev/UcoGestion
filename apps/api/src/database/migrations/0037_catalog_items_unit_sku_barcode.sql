ALTER TABLE catalog_items
  ADD COLUMN base_unit text NOT NULL DEFAULT 'UNIT',
  ADD COLUMN sku text,
  ADD COLUMN sku_norm text GENERATED ALWAYS AS (upper(btrim(sku))) STORED,
  ADD COLUMN barcode text,
  ADD COLUMN barcode_norm text GENERATED ALWAYS AS (upper(btrim(barcode))) STORED,
  ADD CONSTRAINT catalog_items_base_unit_check CHECK (base_unit IN ('UNIT', 'FRACTIONAL')),
  ADD CONSTRAINT catalog_items_sku_not_blank_check CHECK (sku IS NULL OR btrim(sku) <> ''),
  ADD CONSTRAINT catalog_items_barcode_not_blank_check CHECK (barcode IS NULL OR btrim(barcode) <> '');

CREATE UNIQUE INDEX catalog_items_organization_sku_norm_key
  ON catalog_items (organization_id, sku_norm)
  WHERE sku_norm IS NOT NULL;

CREATE UNIQUE INDEX catalog_items_organization_barcode_norm_key
  ON catalog_items (organization_id, barcode_norm)
  WHERE barcode_norm IS NOT NULL;

GRANT INSERT (base_unit, sku, barcode), UPDATE (base_unit, sku, barcode) ON catalog_items TO uco_app;
