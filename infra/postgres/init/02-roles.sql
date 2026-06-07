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

-- Read-only GIS publishing role for GeoServer (ADR-0079).
--
-- GeoServer exposes the PostGIS GIS tables as OGC WMS/WFS to QGIS/ArcGIS + the
-- web app. It connects with THIS role — never the superuser. SELECT-only;
-- BYPASSRLS so it can read past the FORCE'd RLS on gis_features/gis_layers
-- (single-site = one tenant, so reading all GIS rows is the intended scope).
-- For multi-tenant, replace with per-tenant SECURITY-DEFINER views + drop
-- BYPASSRLS. The actual table grants live in infra/geoserver/setup.sh because
-- the gis_* tables don't exist yet at first-boot init time (migrations create
-- them afterwards).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geoserver_ro') THEN
    CREATE ROLE geoserver_ro
      LOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      INHERIT
      NOREPLICATION
      BYPASSRLS
      PASSWORD 'cmc_dev_geoserver_change_me';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE cmc TO geoserver_ro;
GRANT USAGE ON SCHEMA public TO geoserver_ro;
