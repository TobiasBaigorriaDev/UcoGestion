ALTER TABLE inventory_adjustments ADD CONSTRAINT inventory_adjustments_reason_allowed_check
  CHECK (reason IN ('INVENTARIO_INICIAL', 'CONTEO_FISICO', 'ROTURA', 'PERDIDA',
    'VENCIMIENTO', 'CORRECCION', 'OTRO'));
