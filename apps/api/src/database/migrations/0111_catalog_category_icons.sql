-- Presentation metadata only; existing categories keep a null/default icon.
ALTER TABLE catalog_categories ADD COLUMN icon text;
ALTER TABLE catalog_categories ADD CONSTRAINT catalog_categories_icon_check CHECK
  (icon IS NULL OR icon IN ('folder', 'apple', 'coffee', 'milk', 'wine', 'beef', 'fish', 'wheat', 'cake-slice', 'candy', 'shirt', 'pill', 'wrench', 'package', 'smartphone', 'leaf', 'shopping-basket', 'utensils', 'egg', 'flower-2'));
GRANT INSERT (icon), UPDATE (icon) ON catalog_categories TO uco_app;
