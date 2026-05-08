import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { authedApiFetch, ApiError } from "@/lib/server-api";
import {
  ListDocumentsResponseSchema,
  type ListDocumentsResponse,
} from "@cmc/contracts";
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
    <main className="container mx-auto flex min-h-screen flex-col gap-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Documents
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">
            Files in {session?.tenantSlug}
          </h1>
          <p className="text-sm text-muted-foreground">
            Upload, list, and download documents scoped to your tenant.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Dashboard
        </Link>
      </header>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-medium">Upload</h2>
        <UploadForm />
      </section>

      <section className="rounded-lg border bg-card">
        <h2 className="border-b p-6 text-lg font-medium">
          {result.ok
            ? `${result.data.total} document${result.data.total === 1 ? "" : "s"}`
            : "Documents"}
        </h2>
        {!result.ok ? (
          <div className="m-6 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">
              Couldn&apos;t load documents
            </p>
            <p className="mt-1 text-muted-foreground">{result.error}</p>
          </div>
        ) : result.data.documents.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No documents yet. Upload one above to see it here.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-6 py-3 font-medium">Name</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Size</th>
                <th className="px-6 py-3 font-medium">Uploaded</th>
                <th className="px-6 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {result.data.documents.map((doc) => (
                <tr key={doc.id} className="border-b last:border-b-0">
                  <td className="px-6 py-3 font-medium">
                    {doc.name}
                    {doc.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {doc.description}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-3 font-mono text-xs text-muted-foreground">
                    {doc.mimeType}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {formatBytes(doc.sizeBytes)}
                  </td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(doc.createdAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-3 text-right">
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
    </main>
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
