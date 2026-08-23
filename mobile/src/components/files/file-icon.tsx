import type { FileIconId, HostEntryKind } from "@/components/files/types";
import { Icon, type IconName } from "@/components/ui/icon";
import { spacing } from "@/theme";

const FILE_ICONS: Record<FileIconId, IconName> = {
  file: "File",
  code: "FileCode",
  text: "FileText",
  markdown: "FileText",
  image: "FileImage",
  vector: "FileImage",
  video: "FileVideoCamera",
  audio: "FileMusic",
  pdf: "FileText",
  doc: "FileText",
  sheet: "FileSpreadsheet",
  slides: "Presentation",
  archive: "FileArchive",
  binary: "Binary",
  key: "FileKey",
  config: "FileCog",
  terminal: "FileTerminal",
  database: "Database",
  font: "FileType",
  symlink: "FileSymlink",
};

export function FileKindIcon({ icon, kind }: { icon: FileIconId; kind: HostEntryKind }) {
  const name = kind === "directory" ? "Folder" : FILE_ICONS[icon];
  return <Icon color="mutedForeground" name={name} size={spacing[5]} />;
}
