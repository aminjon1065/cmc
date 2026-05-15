import type { Metadata } from "next";
import { auth } from "@/auth";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import {
  ListDocumentsResponseSchema,
  type ListDocumentsResponse,
} from "@cmc/contracts";
import { AppShell } from "@/components/cmc/app-shell";
import { UploadForm } from "./upload-form";
import { DocumentRowActions } from "./document-row-actions";

export const metadata: Metadata = {
  title: "Documents",
};

async function fetchDocuments(): Promise<
  { ok: true; data: ListDocumentsResponse } | { ok: false; error: string }
> {
  try {
    const raw = await authedApiFetch<unknown>("/documents");
    const parsed = ListDocumentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "API returned an unexpected shape" };
    }
    return { ok: true, data: parsed.data };
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, error: `API ${err.status}: ${err.message}` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export default async function DocumentsPage() {
  const session = await auth();
  const result = await fetchDocuments();

  return (
    <AppShell
      active="docs"
      crumbs={["Knowledge", "Documents"]}
      tenant={session?.tenantSlug}
      user={{
        name: session?.user?.name ?? null,
        role: "Operations Lead · L4",
      }}
    >
      <div
        className="flex items-center gap-5 px-5 py-4"
        style={{ borderBottom: "0.5px solid var(--c-line-2)" }}
      >
        <div>
          <div className="cmc-label mb-1">Document Management · EDMS</div>
          <div
            className="cmc-display text-[22px] font-semibold"
            style={{ letterSpacing: "-0.01em" }}
          >
            Files in {session?.tenantSlug}
          </div>
          <div
            className="mt-1 text-[11.5px]"
            style={{ color: "var(--c-fg-3)" }}
          >
            Tenant-scoped storage with retention, classification, and
            tamper-evident audit trail.
          </div>
        </div>
        <div className="flex-1" />
        {result.ok && (
          <span className="cmc-chip cmc-chip-accent">
            {result.data.total} document
            {result.data.total === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 p-5">
        <section className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Upload</span>
          </div>
          <div className="p-4">
            <UploadForm />
          </div>
        </section>

        <section className="cmc-card">
          <div className="cmc-card-header">
            <span className="cmc-label">Documents</span>
            <div className="flex-1" />
            <span
              className="text-[10.5px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              Sorted by upload date
            </span>
          </div>
          {!result.ok ? (
            <div
              className="m-4 rounded-md p-3 text-[12px]"
              style={{
                color: "var(--c-sev-1)",
                background: "var(--c-sev-1-soft)",
                border:
                  "0.5px solid color-mix(in srgb, var(--c-sev-1) 30%, transparent)",
              }}
            >
              <div className="font-medium">Couldn&apos;t load documents</div>
              <div
                className="mt-0.5"
                style={{ color: "var(--c-fg-3)" }}
              >
                {result.error}
              </div>
            </div>
          ) : result.data.documents.length === 0 ? (
            <div
              className="p-5 text-[12px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              No documents yet. Upload one above to see it here.
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr
                  style={{
                    color: "var(--c-fg-3)",
                    borderBottom: "0.5px solid var(--c-line-1)",
                  }}
                >
                  <th className="cmc-label px-4 py-2.5 text-left font-medium">
                    Name
                  </th>
                  <th className="cmc-label px-4 py-2.5 text-left font-medium">
                    Type
                  </th>
                  <th className="cmc-label px-4 py-2.5 text-left font-medium">
                    Size
                  </th>
                  <th className="cmc-label px-4 py-2.5 text-left font-medium">
                    Uploaded
                  </th>
                  <th className="cmc-label px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {result.data.documents.map((doc, i) => (
                  <tr
                    key={doc.id}
                    style={{
                      borderBottom:
                        i < result.data.documents.length - 1
                          ? "0.5px solid var(--c-line-1)"
                          : undefined,
                    }}
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{doc.name}</div>
                      {doc.description && (
                        <div
                          className="mt-0.5 text-[11px]"
                          style={{ color: "var(--c-fg-3)" }}
                        >
                          {doc.description}
                        </div>
                      )}
                    </td>
                    <td
                      className="cmc-mono px-4 py-2.5 text-[10.5px]"
                      style={{ color: "var(--c-fg-3)" }}
                    >
                      {doc.mimeType}
                    </td>
                    <td
                      className="cmc-mono px-4 py-2.5"
                      style={{ color: "var(--c-fg-2)" }}
                    >
                      {formatBytes(doc.sizeBytes)}
                    </td>
                    <td
                      className="cmc-mono px-4 py-2.5 text-[11px]"
                      style={{ color: "var(--c-fg-3)" }}
                    >
                      {new Date(doc.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <DocumentRowActions
                        documentId={doc.id}
                        documentName={doc.name}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
