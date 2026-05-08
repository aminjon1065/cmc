"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { initUploadAction, finalizeUploadAction } from "./actions";

type UploadState =
  | { phase: "idle" }
  | { phase: "initializing"; name: string }
  | { phase: "uploading"; name: string; progress: number }
  | { phase: "finalizing"; name: string }
  | { phase: "error"; message: string };

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  async function handleFile(file: File) {
    setState({ phase: "initializing", name: file.name });
    const init = await initUploadAction({
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
    if (!init.ok) {
      setState({ phase: "error", message: init.error });
      return;
    }

    setState({ phase: "uploading", name: file.name, progress: 0 });
    try {
      await uploadWithProgress(
        init.data.uploadUrl,
        init.data.headers,
        file,
        (p) => {
          setState({ phase: "uploading", name: file.name, progress: p });
        },
      );
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Upload failed",
      });
      return;
    }

    setState({ phase: "finalizing", name: file.name });
    const fin = await finalizeUploadAction(init.data.documentId);
    if (!fin.ok) {
      setState({ phase: "error", message: fin.error });
      return;
    }

    setState({ phase: "idle" });
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    void handleFile(file);
  }

  const busy = state.phase !== "idle" && state.phase !== "error";

  return (
    <div className="flex flex-col gap-3">
      <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
        {busy ? "Uploading…" : "Upload file"}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={onChange}
          disabled={busy}
        />
      </label>

      {state.phase === "initializing" && (
        <p className="text-sm text-muted-foreground">
          Preparing <span className="font-mono">{state.name}</span>…
        </p>
      )}
      {state.phase === "uploading" && (
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <span>
            Uploading <span className="font-mono">{state.name}</span> —{" "}
            {state.progress}%
          </span>
          <div className="h-1.5 w-64 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        </div>
      )}
      {state.phase === "finalizing" && (
        <p className="text-sm text-muted-foreground">
          Finalizing <span className="font-mono">{state.name}</span>…
        </p>
      )}
      {state.phase === "error" && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}

/**
 * PUT a file to S3/MinIO with progress events. We use XHR rather than fetch
 * because fetch's body upload progress is not yet broadly available.
 */
function uploadWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}
