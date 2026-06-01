"use client";

import { useEffect, useRef, useState } from "react";

// Pinned swagger-ui-dist served from a CDN. The sensitive artifact — the spec —
// is fetched server-side through the gated BFF; only the open-source renderer
// (JS+CSS) comes from the CDN. TODO(TD): self-host these assets for air-gapped
// deployments.
const SWAGGER_VERSION = "5.17.14";
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}`;

type SwaggerUIBundleFn = (opts: Record<string, unknown>) => void;

function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) return resolve();
    const s = document.createElement("script");
    s.id = id;
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.body.appendChild(s);
  });
}

/**
 * Renders an OpenAPI document with Swagger UI (P1.10b / ADR-0028). The `spec` is
 * passed in (server-fetched via the BFF, bearer attached), so no client-side
 * auth is needed just to read the docs. "Try it out" targets the API origin via
 * the spec's `servers` entry; the user supplies a token through Swagger UI's
 * Authorize dialog.
 */
export function SwaggerUiClient({ spec }: { spec: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!document.getElementById("swagger-ui-css")) {
      const link = document.createElement("link");
      link.id = "swagger-ui-css";
      link.rel = "stylesheet";
      link.href = `${CDN}/swagger-ui.css`;
      document.head.appendChild(link);
    }

    loadScript(`${CDN}/swagger-ui-bundle.js`, "swagger-ui-bundle")
      .then(() => {
        if (cancelled || !ref.current) return;
        const bundle = (
          window as unknown as { SwaggerUIBundle?: SwaggerUIBundleFn }
        ).SwaggerUIBundle;
        if (!bundle) {
          setError("Swagger UI failed to initialise.");
          return;
        }
        bundle({
          spec,
          domNode: ref.current,
          deepLinking: true,
          persistAuthorization: true,
          defaultModelsExpandDepth: 0,
          docExpansion: "list",
          tryItOutEnabled: true,
        });
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load Swagger UI.");
      });

    return () => {
      cancelled = true;
    };
  }, [spec]);

  if (error) {
    return (
      <div className="cmc-card p-4 text-[12px]" style={{ color: "var(--c-sev1)" }}>
        {error} — the renderer is loaded from a CDN; check connectivity.
      </div>
    );
  }

  // Swagger UI ships its own light theme; give it a white surface so it reads as
  // an intentional panel inside the dark shell.
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 8,
        overflow: "hidden",
        border: "0.5px solid var(--c-line-2)",
      }}
    >
      <div ref={ref} />
    </div>
  );
}
