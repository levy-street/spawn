export const WORKER_BASE_URL = "https://spawn.local/";

export interface WorkerNavigationRequest {
  url: string;
}

/** Allows only the document WebView was explicitly asked to bootstrap. */
export function isWorkerBootstrapNavigation(
  request: WorkerNavigationRequest,
  fileWorkerUrl: string | null = null,
): boolean {
  if (request.url === "about:blank" || request.url === WORKER_BASE_URL) {
    return true;
  }

  return fileWorkerUrl !== null && request.url === fileWorkerUrl;
}
