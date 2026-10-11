-- Category is mutable master data; historical document snapshots stay immutable.
GRANT UPDATE (category_id) ON catalog_items TO uco_app;
