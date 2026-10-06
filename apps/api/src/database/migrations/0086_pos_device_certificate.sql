ALTER TABLE devices ADD COLUMN public_key_thumbprint text;
CREATE UNIQUE INDEX devices_organization_thumbprint_key
  ON devices (organization_id, public_key_thumbprint)
  WHERE public_key_thumbprint IS NOT NULL;
ALTER TABLE devices ADD CONSTRAINT devices_pos_public_key_check
  CHECK (public_key_thumbprint IS NULL OR (public_key IS NOT NULL AND branch_id IS NOT NULL));
GRANT INSERT (public_key_thumbprint, last_seen_at) ON devices TO uco_app;
