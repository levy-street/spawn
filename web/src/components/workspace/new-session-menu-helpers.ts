import { ApiError } from "@/lib/api";

export function isWorkspaceFullError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  if (error.code === "workspace_full" || error.detail === "workspace_full") return true;
  if (typeof error.detail === "object" && error.detail !== null) {
    const detail = error.detail as Record<string, unknown>;
    return detail.code === "workspace_full" || detail.detail === "workspace_full";
  }
  return error.message === "workspace_full";
}
