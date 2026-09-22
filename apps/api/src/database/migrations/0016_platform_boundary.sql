CREATE SCHEMA platform_api;

REVOKE ALL ON SCHEMA public FROM uco_platform;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM uco_platform;
GRANT USAGE ON SCHEMA platform_api TO uco_platform;
REVOKE ALL ON SCHEMA platform_api FROM PUBLIC;
