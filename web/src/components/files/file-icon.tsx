import {
  Binary,
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileMusic,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  Presentation,
  Shapes,
} from "lucide-react";
import type { ComponentType } from "react";

import type { HostDirEntry } from "@/lib/hostControl";
import { classifyFile, type FileIconId } from "@/lib/preview/file-kinds";

/**
 * A glyph for a file, chosen from its name.
 *
 * Shape only — every file icon keeps `text-muted-foreground`, and folders keep
 * their `text-info` blue. Colouring by type would put chroma on three thousand
 * rows and fight a palette that is otherwise pure neutral; the silhouette is
 * enough to tell a spreadsheet from a movie at a glance.
 */
const ICONS: Record<FileIconId, ComponentType<{ className?: string }>> = {
  file: File,
  code: FileCode,
  text: FileText,
  markdown: FileText,
  image: FileImage,
  vector: Shapes,
  video: FileVideoCamera,
  audio: FileMusic,
  pdf: FileType,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  binary: Binary,
  key: FileKey,
  config: FileCog,
  terminal: FileTerminal,
  database: Database,
  font: FileType,
  symlink: FileSymlink,
};

export function FileIcon({
  name,
  kind,
  className,
}: {
  name: string;
  kind?: HostDirEntry["kind"];
  className?: string;
}) {
  const Glyph = ICONS[classifyFile({ name, kind }).icon] ?? File;
  return <Glyph className={className} />;
}
