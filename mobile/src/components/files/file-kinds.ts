import {
  BY_EXTENSION,
  COMPOUND,
  DOC_PREFIXES,
  type FileKindEntry,
  UNKNOWN_FILE,
  WHOLE_NAME,
} from "@/components/files/file-kind-registry";
import type { FileTypeInfo, HostDirEntry, PreviewKind } from "@/components/files/types";

export const PREVIEW_BUDGET = {
  hoverText: 96 * 1024,
  hoverImage: 4 * 1024 * 1024,
  autoFetch: 4 * 1024 * 1024,
  inlineMax: 24 * 1024 * 1024,
  textDecode: 1024 * 1024,
  pdfMax: 128 * 1024 * 1024,
  mediaMax: 512 * 1024 * 1024,
  thumbPx: { hover: 256, modal: 1024 },
} as const;

export type PreviewBudgetDecision = "auto" | "confirm" | "blocked";

export function previewBudgetDecision(
  size: number | null | undefined,
  info: FileTypeInfo,
): PreviewBudgetDecision {
  if (typeof size !== "number") return "confirm";
  if (size > info.maxBytes) return "blocked";
  if (size > info.autoBytes) return "confirm";
  return "auto";
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function compoundOf(lower: string): FileKindEntry | undefined {
  for (const [suffix, entry] of COMPOUND) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) return entry;
  }
  return undefined;
}

function extensionlessEntry(lower: string): FileKindEntry {
  const matched = DOC_PREFIXES.find(([prefix]) => lower.startsWith(prefix));
  return {
    kind: "text",
    label: matched?.[1] ?? "Text file",
    mime: "text/plain",
    icon: "text",
  };
}

function finish(entry: FileKindEntry): FileTypeInfo {
  const autoBytes = entry.autoBytes ?? PREVIEW_BUDGET.autoFetch;
  return {
    kind: entry.kind,
    label: entry.label,
    mime: entry.mime,
    icon: entry.icon,
    ...(entry.language ? { language: entry.language } : {}),
    autoBytes,
    maxBytes: entry.maxBytes ?? PREVIEW_BUDGET.inlineMax,
    ...(entry.executable ? { executable: true } : {}),
  };
}

export function classifyFile(
  entry: Pick<HostDirEntry, "name"> & Partial<Pick<HostDirEntry, "kind" | "size">>,
): FileTypeInfo {
  if (entry.kind === "symlink") {
    return finish({
      kind: "none",
      label: "Symbolic link",
      mime: "application/octet-stream",
      icon: "symlink",
    });
  }
  if (entry.kind === "directory") {
    return finish({ kind: "none", label: "Folder", mime: "", icon: "file" });
  }
  if (entry.kind === "other") {
    return finish({
      kind: "none",
      label: "Special file",
      mime: "application/octet-stream",
      icon: "binary",
    });
  }
  const lower = entry.name.toLowerCase();
  const extension = extensionOf(entry.name);
  return finish(
    WHOLE_NAME[lower] ??
      compoundOf(lower) ??
      (extension ? BY_EXTENSION[extension] : undefined) ??
      (extension ? UNKNOWN_FILE : extensionlessEntry(lower)),
  );
}

export function isNativeKind(kind: PreviewKind): boolean {
  return kind !== "quicklook" && kind !== "none";
}

export function isTextKind(kind: PreviewKind): boolean {
  return kind === "text" || kind === "code" || kind === "markdown";
}
