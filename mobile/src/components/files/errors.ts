type FileErrorContext = "list" | "read" | "write" | "rename" | "remove";

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = "code" in error ? error.code : undefined;
  if (typeof direct === "string") return direct;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    [
      "outside_root",
      "traversal_rejected",
      "permission_denied",
      "not_found",
      "not_directory",
      "not_file",
      "symlink_rejected",
      "file_too_large",
      "already_exists",
      "root_protected",
      "file_changed",
    ].find((code) => message.includes(code)) ?? null
  );
}

export function fileErrorMessage(error: unknown, context: FileErrorContext): string {
  switch (errorCode(error)) {
    case "outside_root":
    case "traversal_rejected":
      return "That folder sits above your home folder, which is as far up as Spawn can browse.";
    case "permission_denied":
      return context === "list"
        ? "You do not have permission to open this folder."
        : "You do not have permission to change this item.";
    case "not_found":
      return context === "list" ? "This folder no longer exists." : "This item no longer exists.";
    case "not_directory":
      return "That is a file, not a folder.";
    case "not_file":
      return "That is a folder, not a file.";
    case "symlink_rejected":
      return "This is a symbolic link, which Spawn does not follow.";
    case "file_too_large":
      return "This file is too large to transfer.";
    case "already_exists":
      return "An item with that name already exists.";
    case "root_protected":
      return "Your home folder cannot be renamed or deleted.";
    case "file_changed":
      return "This file changed during transfer. Try again.";
    default:
      if (error instanceof Error && error.message.trim()) return error.message;
      return context === "list" ? "Could not list this folder." : "The file operation failed.";
  }
}
