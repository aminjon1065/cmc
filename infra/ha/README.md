# HA data-layer sample (P3.13 / ADR-0058)

A standalone reference topology for the **stateful tier**: Postgres
primary + streaming standby, PgBouncer, and a Redis master/replica with a 3-node
Sentinel quorum. It is **not** part of the default dev or deploy stacks — those
stay single-node for Postgres/Redis. The *stateless* tier (2× API behind Caddy +
PgBouncer) is real in `infra/deploy-compose.yml`.

```bash
docker compose -f infra/ha/docker-compose.ha.yml config    # lint the topology
docker compose -f infra/ha/docker-compose.ha.yml up -d      # stand it up
```

Full operating notes — scaling the API, why N× API is safe (advisory-locked
singletons), PgBouncer/transaction-pooling compatibility, and failover
behaviour — are in **`docs/runbooks/ha.md`**.

Production note: this sample uses bitnami images so the replication *topology* is
legible. Production Postgres must be **PostGIS-capable** — run a managed HA
Postgres or Patroni/Stolon with the same primary/standby + PgBouncer shape.
