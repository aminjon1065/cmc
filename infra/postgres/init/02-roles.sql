-- Application-runtime role.
--
-- Per ADR-0004: the Postgres role bound to the API connection pool MUST NOT
-- be a superuser and MUST NOT have BYPASSRLS, otherwise the row-level
-- security policies enforced by `app.tenant_id` are silently no-ops.
--
-- The bootstrap user (`POSTGRES_USER`, default `cmc`) remains the table
-- owner; it has BYPASSRLS by virtue of being a superuser, and that is
-- intentional — owner connections run migrations and seed scripts
-- pre-tenant. The application connection uses `cmc_app` instead.
--
-- This script runs only on the very first container start (Postgres image
-- only sources /docker-entrypoint-initdb.d on a fresh data dir). For an
-- existing volume, run the same statements manually.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmc_app') THEN
    CREATE ROLE cmc_app
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      INHERIT
      NOREPLICATION
      NOBYPASSRLS
      PASSWORD 'cmc_app_dev_password_change_me';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE cmc TO cmc_app;
GRANT USAGE ON SCHEMA public TO cmc_app;

-- Existing tables — runtime role can read/write rows but cannot DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cmc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cmc_app;

-- Future tables — auto-grant when the owner (`cmc`) creates them via
-- migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE cmc IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cmc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cmc IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cmc_app;
