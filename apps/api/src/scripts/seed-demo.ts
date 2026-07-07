/**
 * Demo-data seeder. Drives the REAL HTTP API (login → create) so the full event
 * pipeline fires exactly as in production: incident insert → outbox → NATS relay
 * → ClickHouse projection (the analytics dashboard reads the resulting rollup).
 *
 * It creates:
 *   - ~60 incidents spread across the last 30 days, with two deliberate spike
 *     days so the realtime anomaly detector (Z-score) has something to flag;
 *   - a realistic mix of statuses (some triaged / in-progress / resolved);
 *   - a GIS *point* layer mirroring the incident locations, so the /map page
 *     lights up via MVT vector tiles (no GeoServer needed).
 *
 * Idempotency: this is additive — every run appends a fresh batch. Run it once
 * for a populated dev environment. Requires the API up with the analytics
 * pipeline enabled (NATS_ENABLED, CLICKHOUSE_ENABLED).
 *
 *   pnpm --filter @cmc/api seed:demo
 */

const API = process.env.API_BASE ?? "http://localhost:3001";
const EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@cmc.local";
const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin123456";

/** Tajikistan regions (names match the seed) + an approximate centroid. */
const REGIONS = [
  { name: "Душанбе", lat: 38.5598, lng: 68.787, weight: 3 },
  { name: "Согдийская область", lat: 40.2839, lng: 69.622, weight: 3 },
  { name: "Хатлонская область", lat: 37.8364, lng: 68.7811, weight: 3 },
  { name: "ГБАО", lat: 37.4895, lng: 71.556, weight: 1 },
  { name: "Районы республиканского подчинения", lat: 38.95, lng: 69.2, weight: 2 },
] as const;

/** Civil-emergency incident types (КЧС domain). */
const TYPES = [
  "Землетрясение",
  "Наводнение",
  "Сель",
  "Оползень",
  "Лавина",
  "Пожар",
  "ДТП",
  "Прорыв плотины",
  "Эпидемия",
  "Снежный занос",
  "Засуха",
  "Сильный ветер",
] as const;

const SOURCES = [
  "Оперативный дежурный",
  "МЧС-региональный центр",
  "Звонок 112",
  "Спутниковый мониторинг",
  "Гидрометцентр",
] as const;

type Created = {
  id: string;
  lat: number;
  lng: number;
  type: string;
  severity: number;
  region: string;
  summary: string;
};

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function weightedRegion(): (typeof REGIONS)[number] {
  const pool = REGIONS.flatMap((r) => Array<typeof r>(r.weight).fill(r));
  return pick(pool);
}
/** Severity skewed toward 2–4 (few SEV-1, few SEV-5). */
function weightedSeverity(): number {
  return pick([1, 2, 2, 3, 3, 3, 4, 4, 5]);
}
function jitter(base: number, spread = 0.35): number {
  return +(base + (Math.random() - 0.5) * 2 * spread).toFixed(5);
}

async function api<T>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Per-day incident counts for the last `days` days, with two spikes. */
function dailyPlan(days: number): number[] {
  const plan: number[] = [];
  for (let i = 0; i < days; i++) plan.push(Math.floor(Math.random() * 4)); // 0–3
  // Deliberate spikes for the anomaly detector.
  plan[days - 1 - 7] = 9 + Math.floor(Math.random() * 3); // ~1 week ago
  plan[days - 1 - 18] = 8 + Math.floor(Math.random() * 3); // ~2.5 weeks ago
  return plan;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Seeding demo data via ${API} …`);

  const login = await api<{ accessToken: string }>(
    "POST",
    "/v1/auth/login",
    null,
    { email: EMAIL, password: PASSWORD },
  );
  const token = login.accessToken;

  const DAYS = 30;
  const plan = dailyPlan(DAYS);
  const created: Created[] = [];
  const now = Date.now();

  for (let d = 0; d < DAYS; d++) {
    const count = plan[d]!;
    const dayOffset = DAYS - 1 - d; // 0 = today, DAYS-1 = oldest
    for (let n = 0; n < count; n++) {
      const region = weightedRegion();
      const type = pick(TYPES);
      const severity = weightedSeverity();
      // Random time within that day.
      const occurred = new Date(
        now - dayOffset * 86_400_000 - Math.floor(Math.random() * 86_400_000),
      );
      const lat = jitter(region.lat);
      const lng = jitter(region.lng);
      const summary = `${type} — ${region.name}`;
      try {
        // The incidents controller wraps the created row as `{ incident: {...} }`.
        const inc = await api<{ incident: { id: string } }>(
          "POST",
          "/v1/incidents",
          token,
          {
            severity,
            type,
            region: region.name,
            source: pick(SOURCES),
            summary,
            description: `Демо-инцидент: ${type.toLowerCase()} в регионе «${region.name}». Сгенерировано сидером для проверки аналитики и карты.`,
            latitude: lat,
            longitude: lng,
            occurredAt: occurred.toISOString(),
          },
        );
        created.push({
          id: inc.incident.id,
          lat,
          lng,
          type,
          severity,
          region: region.name,
          summary,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`  incident create failed: ${(e as Error).message}`);
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`✓ Created ${created.length} incidents across ${DAYS} days.`);

  // Realistic status mix: walk a fraction of incidents down the state machine.
  // Each transition is best-effort (a state-machine surprise won't abort the run).
  const stepPath = ["triaged", "in_progress", "resolved", "closed"] as const;
  async function advance(id: string, steps: number): Promise<void> {
    for (let i = 0; i < steps; i++) {
      try {
        await api("POST", `/v1/incidents/${id}/transition`, token, {
          to: stepPath[i],
        });
      } catch {
        return; // stop at first invalid transition
      }
    }
  }
  let triaged = 0;
  let inProgress = 0;
  let resolved = 0;
  for (const inc of created) {
    const r = Math.random();
    if (r < 0.25) {
      await advance(inc.id, 3); // → resolved
      resolved++;
    } else if (r < 0.45) {
      await advance(inc.id, 2); // → in_progress
      inProgress++;
    } else if (r < 0.65) {
      await advance(inc.id, 1); // → triaged
      triaged++;
    } // else stays "reported"
  }
  // eslint-disable-next-line no-console
  console.log(
    `✓ Status mix: ${resolved} resolved, ${inProgress} in-progress, ${triaged} triaged, ${
      created.length - resolved - inProgress - triaged
    } reported.`,
  );

  // GIS point layer mirroring the incident locations → the /map page renders it
  // as MVT circles (set NEXT_PUBLIC_GIS_SOURCE=mvt on the web).
  const layer = await api<{ id: string }>("POST", "/v1/gis/layers", token, {
    name: "Очаги инцидентов (демо)",
    kind: "point",
    isPublic: false,
  });
  let features = 0;
  for (const inc of created) {
    try {
      await api("POST", `/v1/gis/layers/${layer.id}/features`, token, {
        geometry: { type: "Point", coordinates: [inc.lng, inc.lat] },
        properties: {
          type: inc.type,
          severity: inc.severity,
          region: inc.region,
          summary: inc.summary,
        },
      });
      features++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`  feature create failed: ${(e as Error).message}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`✓ GIS layer "Очаги инцидентов (демо)" with ${features} point features.`);
  // eslint-disable-next-line no-console
  console.log(
    "Demo seed complete. The relay → ClickHouse projection fills within a few seconds.",
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Demo seed failed:", err);
  process.exit(1);
});
