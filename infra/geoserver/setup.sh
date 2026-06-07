#!/usr/bin/env bash
#
# Configure GeoServer over the CMC PostGIS database (ADR-0079).
#
# Publishes the PostGIS GIS tables as OGC WMS/WFS so QGIS, ArcGIS Pro and the
# web app all read ONE source of truth. GeoServer connects with the read-only
# `geoserver_ro` role (created in infra/postgres/init/02-roles.sql).
#
# Idempotent — safe to re-run. Run after `pnpm infra:up` AND DB migrations
# (the gis_* tables must exist). Requires `psql` + `curl` on the host.
#
#   bash infra/geoserver/setup.sh
#
set -euo pipefail

GS_URL="${GS_URL:-http://localhost:8088/geoserver}"
GS_USER="${GEOSERVER_ADMIN_USER:-admin}"
GS_PASS="${GEOSERVER_ADMIN_PASSWORD:-cmc_dev_geoserver_admin_change_me}"
WS="${GS_WORKSPACE:-cmc}"
STORE="${GS_STORE:-postgis}"

# How GeoServer (inside cmc-net) reaches the DB — service name `postgres`.
PG_HOST="${GS_DB_HOST:-postgres}"
PG_PORT="${GS_DB_PORT:-5432}"
PG_DB="${GS_DB_NAME:-cmc}"
PG_USER="${GS_DB_USER:-geoserver_ro}"
PG_PASS="${GS_DB_PASSWORD:-cmc_dev_geoserver_change_me}"

# Superuser URI (host side) — used only to GRANT SELECT to geoserver_ro, since
# the gis_* tables don't exist at first-boot init time.
SU_URL="${DATABASE_OWNER_URL:-postgresql://cmc:cmc_dev_password_change_me@localhost:5432/cmc}"

code() { curl -s -o /dev/null -w '%{http_code}' -u "$GS_USER:$GS_PASS" "$@"; }
post() { curl -sS -u "$GS_USER:$GS_PASS" "$@" >/dev/null; }

echo "==> GRANT SELECT on gis_* to geoserver_ro"
psql "$SU_URL" -v ON_ERROR_STOP=1 -c \
  "GRANT SELECT ON gis_features, gis_layers TO geoserver_ro;" >/dev/null

echo "==> Workspace '$WS'"
if [ "$(code "$GS_URL/rest/workspaces/$WS")" = "404" ]; then
  post -X POST -H 'Content-Type: application/json' \
    -d "{\"workspace\":{\"name\":\"$WS\"}}" "$GS_URL/rest/workspaces"
  echo "   created"
else echo "   already exists"; fi

echo "==> PostGIS datastore '$WS:$STORE'"
if [ "$(code "$GS_URL/rest/workspaces/$WS/datastores/$STORE")" = "404" ]; then
  post -X POST -H 'Content-Type: application/xml' \
    "$GS_URL/rest/workspaces/$WS/datastores" \
    -d "<dataStore><name>$STORE</name><connectionParameters>
      <entry key=\"dbtype\">postgis</entry>
      <entry key=\"host\">$PG_HOST</entry>
      <entry key=\"port\">$PG_PORT</entry>
      <entry key=\"database\">$PG_DB</entry>
      <entry key=\"schema\">public</entry>
      <entry key=\"user\">$PG_USER</entry>
      <entry key=\"passwd\">$PG_PASS</entry>
      <entry key=\"Expose primary keys\">true</entry>
    </connectionParameters></dataStore>"
  echo "   created"
else echo "   already exists"; fi

echo "==> Layer '$WS:gis_features'"
if [ "$(code "$GS_URL/rest/workspaces/$WS/datastores/$STORE/featuretypes/gis_features")" = "404" ]; then
  post -X POST -H 'Content-Type: application/xml' \
    "$GS_URL/rest/workspaces/$WS/datastores/$STORE/featuretypes?recalculate=nativebbox,latlonbbox" \
    -d '<featureType><name>gis_features</name><nativeName>gis_features</nativeName><srs>EPSG:4326</srs></featureType>'
  echo "   published"
else echo "   already exists"; fi

SLD_FILE="$(cd "$(dirname "$0")" && pwd)/styles/cmc_default.sld"

echo "==> Style 'cmc_default'"
if [ "$(code "$GS_URL/rest/workspaces/$WS/styles/cmc_default")" = "404" ]; then
  post -X POST -H "Content-Type: application/vnd.ogc.sld+xml" \
    --data-binary "@$SLD_FILE" "$GS_URL/rest/workspaces/$WS/styles?name=cmc_default"
  echo "   created"
else
  post -X PUT -H "Content-Type: application/vnd.ogc.sld+xml" \
    --data-binary "@$SLD_FILE" "$GS_URL/rest/workspaces/$WS/styles/cmc_default"
  echo "   updated"
fi

set_default_style() { # $1 = layer name within the workspace
  post -X PUT -H 'Content-Type: application/json' \
    -d "{\"layer\":{\"defaultStyle\":{\"name\":\"$WS:cmc_default\"}}}" \
    "$GS_URL/rest/layers/$WS:$1"
}

echo "==> Default style on gis_features (all features)"
set_default_style gis_features

echo "==> Per-layer named SQL-view layers (one per gis_layers row)"
psql "$SU_URL" -tA -F'|' -v ON_ERROR_STOP=1 \
  -c "SELECT id, name FROM gis_layers WHERE deleted_at IS NULL ORDER BY name" |
while IFS='|' read -r LID LNAME; do
  [ -z "$LID" ] && continue
  SLUG=$(printf '%s' "$LNAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/_/g; s/^_//; s/_$//')
  [ -z "$SLUG" ] && SLUG="layer_${LID%%-*}"
  echo "   - $LNAME -> $WS:$SLUG"
  if [ "$(code "$GS_URL/rest/workspaces/$WS/datastores/$STORE/featuretypes/$SLUG")" = "404" ]; then
    post -X POST -H 'Content-Type: application/xml' \
      "$GS_URL/rest/workspaces/$WS/datastores/$STORE/featuretypes?recalculate=nativebbox,latlonbbox" \
      -d "<featureType><name>$SLUG</name><nativeName>$SLUG</nativeName><title>$LNAME</title><srs>EPSG:4326</srs>
        <metadata><entry key=\"JDBC_VIRTUAL_TABLE\"><virtualTable>
          <name>$SLUG</name>
          <sql>SELECT id, geometry, (properties-&gt;&gt;'name') AS name, properties::text AS properties, created_at FROM gis_features WHERE layer_id = '$LID' AND deleted_at IS NULL</sql>
          <geometry><name>geometry</name><type>Geometry</type><srid>4326</srid></geometry>
        </virtualTable></entry></metadata></featureType>"
    echo "     published"
  else echo "     exists"; fi
  set_default_style "$SLUG"
done

echo
echo "==> Done. OGC endpoints for QGIS / ArcGIS / web:"
echo "   WMS: $GS_URL/$WS/wms"
echo "   WFS: $GS_URL/$WS/wfs"
echo "   (GetCapabilities: append ?service=WMS&version=1.3.0&request=GetCapabilities)"
