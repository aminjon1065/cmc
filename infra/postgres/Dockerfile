FROM postgis/postgis:16-3.4

# Add pgvector to the PostGIS-enabled base image so a single Postgres instance
# covers OLTP, spatial, and vector workloads (per ADR-0001).
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
