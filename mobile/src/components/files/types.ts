export type HostEntryKind = "file" | "directory" | "symlink" | "other";

export interface HostDirEntry {
  name: string;
  path: string;
  kind: HostEntryKind;
  is_dir: boolean;
  size?: number | null;
  modified_at?: number | null;
}

export interface HostDirList {
  path: string;
  home_dir: string;
  parent?: string | null;
  entries: HostDirEntry[];
  next_cursor?: number | null;
  truncated?: boolean;
}

export interface HostHome {
  home_dir: string;
}

export type PreviewKind =
  | "image"
  | "svg"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "code"
  | "markdown"
  | "quicklook"
  | "none";

export type FileIconId =
  | "file"
  | "code"
  | "text"
  | "markdown"
  | "image"
  | "vector"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "archive"
  | "binary"
  | "key"
  | "config"
  | "terminal"
  | "database"
  | "font"
  | "symlink";

export type CodeLanguage =
  | "c-like"
  | "js"
  | "ts"
  | "jsx"
  | "python"
  | "shell"
  | "rust"
  | "go"
  | "css"
  | "json"
  | "yaml"
  | "toml"
  | "sql"
  | "xml"
  | "markdown"
  | "plain";

export interface FileTypeInfo {
  kind: PreviewKind;
  label: string;
  mime: string;
  icon: FileIconId;
  language?: CodeLanguage;
  autoBytes: number;
  maxBytes: number;
  executable?: boolean;
}

export interface HostReadDeclaration {
  stream_id: string;
  path: string;
  name: string;
  length: number;
  sha256: string;
}

export type HostIncomingStreamFrame =
  | { type: "stream.chunk"; stream_id: string; sequence: number; bytes: Uint8Array }
  | { type: "stream.end"; stream_id: string; length: number; sha256: string }
  | { type: "stream.error"; stream_id: string; code: string; detail?: string };

export type HostUploadPhase =
  | "queued"
  | "hashing"
  | "declaring"
  | "streaming"
  | "finalizing"
  | "outcome_unknown"
  | "complete"
  | "failed"
  | "cancelled";

export interface TransferProgress {
  phase: HostUploadPhase;
  transferred: number;
  total: number;
}
