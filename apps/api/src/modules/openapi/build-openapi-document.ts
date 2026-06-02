import type { INestApplication } from "@nestjs/common";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import { buildContractComponentSchemas } from "./contract-schemas";

const API_PREFIX = "/v1";

/** Minimal view of an OpenAPI operation we mutate during post-processing. */
type Operation = {
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  responses?: Record<
    string,
    { description?: string; content?: Record<string, unknown> }
  >;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * `${method} ${path}` → the response component name (the type the handler
 * returns). Void handlers and types without a contract `*Schema`
 * (`UserRolesResponse`, `TenantBranding`) are intentionally absent — they keep
 * the generator's default response. Drift-safe: an unmatched key simply means
 * no `$ref` is attached (the e2e asserts the marquee ones are wired).
 */
const RESPONSE_SCHEMA: Record<string, string> = {
  // auth
  "post /v1/auth/login": "LoginResponse",
  "post /v1/auth/mfa/verify": "LoginResponse",
  "post /v1/auth/refresh": "RefreshResponse",
  "get /v1/auth/me": "MeResponse",
  "get /v1/auth/sessions": "SessionsListResponse",
  // mfa
  "get /v1/auth/mfa/status": "MfaStatusResponse",
  "post /v1/auth/mfa/enrol": "MfaEnrolResponse",
  "post /v1/auth/mfa/confirm": "MfaBackupCodesResponse",
  "post /v1/auth/mfa/backup-codes/regenerate": "MfaBackupCodesResponse",
  // password reset
  "post /v1/auth/password/admin-reset/{userId}": "AdminResetResponse",
  // rbac
  "get /v1/rbac/me": "MyAccessResponse",
  "get /v1/rbac/permissions": "PermissionCatalogResponse",
  "get /v1/rbac/roles": "RolesListResponse",
  "get /v1/rbac/roles/{id}": "RoleDetailResponse",
  "post /v1/rbac/roles": "RoleDetailResponse",
  "patch /v1/rbac/roles/{id}": "RoleDetailResponse",
  // users
  "get /v1/users": "UsersListResponse",
  "get /v1/users/{id}": "UserDetailResponse",
  "post /v1/users": "UserDetailResponse",
  "patch /v1/users/{id}": "UserDetailResponse",
  // tenant
  "get /v1/tenant": "TenantSettingsResponse",
  "patch /v1/tenant": "TenantSettingsResponse",
  // incidents
  "post /v1/incidents": "IncidentDetailResponse",
  "get /v1/incidents": "IncidentsListResponse",
  "get /v1/incidents/stats": "IncidentStatsResponse",
  "get /v1/incidents/assignees": "IncidentAssigneesResponse",
  "get /v1/incidents/{id}": "IncidentDetailResponse",
  "patch /v1/incidents/{id}": "IncidentDetailResponse",
  "post /v1/incidents/{id}/transition": "IncidentDetailResponse",
  "post /v1/incidents/{id}/assign": "IncidentDetailResponse",
  // cases
  "post /v1/cases": "CaseDetailResponse",
  "get /v1/cases": "CasesListResponse",
  "get /v1/cases/stats": "CaseStatsResponse",
  "get /v1/cases/{id}": "CaseDetailResponse",
  "get /v1/cases/{id}/activity": "CaseActivitiesResponse",
  "patch /v1/cases/{id}": "CaseDetailResponse",
  "post /v1/cases/{id}/transition": "CaseDetailResponse",
  "post /v1/cases/{id}/assign": "CaseDetailResponse",
  "post /v1/cases/{id}/comment": "CaseActivityResponse",
  // notifications
  "get /v1/notifications": "NotificationsListResponse",
  "get /v1/notifications/unread-count": "UnreadCountResponse",
  "get /v1/notifications/preferences": "NotificationPrefsResponse",
  // documents
  "get /v1/documents": "ListDocumentsResponse",
  "get /v1/documents/{id}": "DocumentResponse",
  "post /v1/documents/upload-init": "UploadInitResponse",
  "post /v1/documents/multipart/init": "MultipartInitResponse",
  "post /v1/documents/{id}/multipart/complete": "DocumentResponse",
  "post /v1/documents/{id}/finalize": "FinalizeUploadResponse",
  "get /v1/documents/{id}/download-url": "DownloadUrlResponse",
  // audit chain
  "get /v1/audit/chain/verify": "AuditChainVerifyResponse",
  "post /v1/audit/chain/seal": "AuditSealResponse",
  "post /v1/audit/chain/anchor": "AuditAnchorResponse",
  "get /v1/audit/export/status": "AuditExportStatusResponse",
  "post /v1/audit/export/flush": "AuditExportFlushResponse",
  "get /v1/audit/projection/status": "AuditProjectionStatusResponse",
  "post /v1/audit/projection/flush": "AuditProjectionFlushResponse",
  // events relay
  "get /v1/events/relay/status": "EventRelayStatusResponse",
  "post /v1/events/relay/flush": "EventRelayFlushResponse",
  // realtime
  "get /v1/realtime/status": "RealtimeStatusResponse",
  // analytics
  "get /v1/analytics/dashboard": "DashboardAnalyticsResponse",
  // search
  "get /v1/search": "SearchResponse",
  // gis
  "get /v1/gis/layers": "GisLayersListResponse",
  "post /v1/gis/layers": "GisLayerResponse",
  "get /v1/gis/layers/{id}": "GisLayerResponse",
  "patch /v1/gis/layers/{id}": "GisLayerResponse",
  "get /v1/gis/layers/{layerId}/features": "GisFeaturesListResponse",
  "post /v1/gis/layers/{layerId}/features": "GisFeatureResponse",
  "get /v1/gis/features/{id}": "GisFeatureResponse",
  "patch /v1/gis/features/{id}": "GisFeatureResponse",
};

/**
 * Operations reachable WITHOUT a bearer token: login, token refresh, the
 * pre-auth password flows, the MFA second step (carries an mfa_token, not a
 * bearer), and the public branding read. Everything else inherits the global
 * bearer requirement.
 */
const PUBLIC_OPERATIONS = new Set<string>([
  "post /v1/auth/login",
  "post /v1/auth/refresh",
  "post /v1/auth/mfa/verify",
  "post /v1/auth/password/forgot",
  "post /v1/auth/password/reset",
  "get /v1/branding",
]);

/** Longest-prefix → tag, so `/v1/auth/mfa/*` groups under `mfa`, not `auth`. */
const TAG_BY_PREFIX: Array<[string, string]> = [
  ["/v1/auth/mfa", "mfa"],
  ["/v1/auth/password", "auth"],
  ["/v1/auth", "auth"],
  ["/v1/rbac", "rbac"],
  ["/v1/users", "users"],
  ["/v1/tenant", "tenant"],
  ["/v1/incidents", "incidents"],
  ["/v1/cases", "cases"],
  ["/v1/search", "search"],
  ["/v1/notifications", "notifications"],
  ["/v1/documents", "documents"],
  ["/v1/branding", "branding"],
  ["/v1/audit", "audit"],
  ["/v1/events", "events"],
  ["/v1/realtime", "realtime"],
  ["/v1/analytics", "analytics"],
  ["/v1/gis", "gis"],
];

/**
 * Operational endpoints are unversioned (ADR-0027) and not part of the client
 * API contract, so they're dropped from the document.
 */
function isOperationalPath(barePath: string): boolean {
  return (
    barePath === "/health" ||
    barePath.startsWith("/health/") ||
    barePath === "/metrics"
  );
}

function tagFor(path: string): string | undefined {
  for (const [prefix, tag] of TAG_BY_PREFIX) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return tag;
  }
  return undefined;
}

/**
 * Build the OpenAPI 3.0 document for the versioned API surface (P1.10 /
 * ADR-0028). Called once from `main.ts` after the app is initialised.
 *
 * Layers, in order:
 *  1. `@nestjs/swagger` introspects routes; the CLI plugin (nest-cli.json)
 *     supplies request DTO schemas (P1.10a).
 *  2. Paths are re-prefixed with `/v1` and operational endpoints dropped.
 *  3. Response schemas come from the `@cmc/contracts` Zod definitions — the
 *     single source of truth — merged as components and `$ref`'d per operation.
 *  4. A global bearer requirement, tags, and public-operation overrides are
 *     applied here so no controller carries Swagger decorators.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("CMC Platform API")
    .setDescription(
      "Unified Enterprise Operational Intelligence Platform — versioned REST API. " +
        "Every route is served under `/v1`. Operational endpoints (`/health*`, " +
        "`/metrics`) are unversioned and intentionally excluded from this document.",
    )
    .setVersion("1.0")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "bearer",
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // (2) Re-prefix domain paths with /v1; drop operational endpoints. The
  // `replace(/^\/v1/, "")` normalisation is idempotent across @nestjs/swagger
  // versions (in case a future one starts including the global prefix).
  const prefixedPaths: (typeof document)["paths"] = {};
  for (const [routePath, pathItem] of Object.entries(document.paths)) {
    const bare = routePath.replace(/^\/v1/, "");
    if (isOperationalPath(bare)) continue;
    prefixedPaths[`${API_PREFIX}${bare}`] = pathItem;
  }
  document.paths = prefixedPaths;

  // (3) Merge the Zod contract schemas alongside the plugin's request DTOs.
  document.components = document.components ?? {};
  document.components.schemas = {
    ...(document.components.schemas ?? {}),
    ...buildContractComponentSchemas(),
  };
  const componentSchemas = document.components.schemas;

  // (4) Global bearer requirement; per-operation tags, response refs, overrides.
  document.security = [{ bearer: [] }];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    const tag = tagFor(path);
    const operations = pathItem as unknown as Record<
      string,
      Operation | undefined
    >;
    for (const method of HTTP_METHODS) {
      const op = operations[method];
      if (!op) continue;
      const key = `${method} ${path}`;

      if (tag) op.tags = [tag];

      const schemaName = RESPONSE_SCHEMA[key];
      if (schemaName && componentSchemas[schemaName]) {
        const responses = op.responses ?? {};
        const successKey =
          Object.keys(responses).find((k) => k.startsWith("2")) ?? "200";
        responses[successKey] = {
          description: responses[successKey]?.description || "Success",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
        };
        op.responses = responses;
      }

      if (PUBLIC_OPERATIONS.has(key)) op.security = [];
    }
  }

  return document;
}
