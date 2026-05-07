-- Extensions enabled at first start of the Postgres container.
-- This script runs only when the data volume is empty (initial bootstrap).
-- For an existing database, run the same statements manually as a superuser.

-- Geospatial
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Vector (for embeddings / semantic search; per ToR §16)
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram similarity + fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Hierarchical paths (used by file-management folder model, ToR §9.1)
CREATE EXTENSION IF NOT EXISTS ltree;

-- UUID generation server-side (gen_random_uuid lives in pgcrypto)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Useful for time-series columns / range partitioning helpers
CREATE EXTENSION IF NOT EXISTS btree_gist;
