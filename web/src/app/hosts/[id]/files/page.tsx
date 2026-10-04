"use client";

import { useParams } from "next/navigation";
import { Suspense } from "react";
import { HostFilesBrowser } from "@/components/files/host-files-browser";

/** The host page's Files section. The frame (shell, header, sections, and the
 *  states that shut Files — an identity conflict, an offline host) is the
 *  layout's — app/hosts/[id]/layout.tsx; it also bounds the height, so the
 *  browser scrolls its own list. */
export default function HostFilesPage() {
  return (
    <Suspense fallback={null}>
      <HostFiles />
    </Suspense>
  );
}

function HostFiles() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  if (!id) return null;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col p-2 @md/shell:p-4">
      {/* Where it opens — never from or into the URL — is the browser's own business. */}
      <HostFilesBrowser
        key={id}
        hostId={id}
        className="overflow-hidden rounded-xl border border-border"
      />
    </div>
  );
}
