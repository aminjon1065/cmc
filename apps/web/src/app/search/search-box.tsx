"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

/** Query input for the global search page — pushes `/search?q=…`. */
export function SearchBox() {
  const router = useRouter();
  const sp = useSearchParams();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const q = String(fd.get("q") ?? "").trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search
          size={15}
          strokeWidth={1.6}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
          style={{ color: "var(--c-fg-3)" }}
        />
        <input
          name="q"
          autoFocus
          defaultValue={sp.get("q") ?? ""}
          placeholder="Search incidents, cases, and documents…"
          className="cmc-input w-full"
          style={{ paddingLeft: 30 }}
        />
      </div>
      <button type="submit" className="cmc-btn">
        Search
      </button>
    </form>
  );
}
