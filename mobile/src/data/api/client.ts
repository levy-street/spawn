import type { ZodType } from "zod";
import { authToken } from "@/data/api/auth-token";
import { getBaseUrl } from "@/data/api/config";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ResponseType = "json" | "text" | "arrayBuffer" | "response";

export type ApiRequestInit<T> = RequestInit & {
  schema?: ZodType<T>;
  timeoutMs?: number;
  auth?: boolean;
  responseType?: ResponseType;
  onResponse?: (response: Response) => unknown | Promise<unknown>;
};

type UnauthenticatedListener = () => void;
const unauthenticatedListeners = new Set<UnauthenticatedListener>();
let unauthenticatedEmitted = false;

export function subscribeUnauthenticated(listener: UnauthenticatedListener): () => void {
  unauthenticatedListeners.add(listener);
  return () => unauthenticatedListeners.delete(listener);
}

function emitUnauthenticated(): void {
  if (unauthenticatedEmitted) return;
  unauthenticatedEmitted = true;
  for (const listener of unauthenticatedListeners) listener();
}

/** Make a non-HTTP authentication refusal follow the same signed-out path. */
export async function reportUnauthenticated(): Promise<void> {
  const token = await authToken.get().catch(() => null);
  if (token !== null) unauthenticatedEmitted = false;
  await authToken.clear();
  emitUnauthenticated();
}

function shouldSetContentType(body: BodyInit | null | undefined): boolean {
  if (typeof FormData !== "undefined" && body instanceof FormData) return false;
  if (typeof Blob !== "undefined" && body instanceof Blob) return false;
  return true;
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: { code?: unknown; message?: unknown; detail?: unknown } | null = null;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as { code?: unknown; message?: unknown; detail?: unknown };
    }
  } catch {
    body = null;
  }
  const code = typeof body?.code === "string" ? body.code : `http_${response.status}`;
  const message =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.detail === "string"
        ? body.detail
        : response.statusText || `HTTP ${response.status}`;
  return new ApiError(response.status, code, message, body?.detail);
}

export async function api<T>(path: string, init: ApiRequestInit<T> = {}): Promise<T> {
  const {
    schema,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    auth = true,
    responseType = "json",
    onResponse,
    headers: requestedHeaders,
    signal: callerSignal,
    ...requestInit
  } = init;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = auth ? await authToken.get() : null;
    if (token !== null) unauthenticatedEmitted = false;
    const headers = new Headers(requestedHeaders);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (!headers.has("Content-Type") && shouldSetContentType(requestInit.body)) {
      headers.set("Content-Type", "application/json");
    }
    if (token !== null && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    let response: Response;
    try {
      response = await fetch(`${await getBaseUrl()}${path}`, {
        ...requestInit,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (controller.signal.aborted) {
        throw new ApiError(0, "timeout", `Request timed out after ${timeoutMs}ms`, error);
      }
      throw new ApiError(
        0,
        "network_error",
        error instanceof Error ? error.message : "Network request failed",
        error,
      );
    }

    await onResponse?.(response);
    if (!response.ok) {
      if (response.status === 401 && auth) {
        if (!unauthenticatedEmitted) {
          await reportUnauthenticated();
        }
      }
      throw await apiErrorFromResponse(response);
    }
    if (response.status === 204) return undefined as T;
    if (responseType === "response") return response as T;
    if (responseType === "text") return (await response.text()) as T;
    if (responseType === "arrayBuffer") return (await response.arrayBuffer()) as T;

    const body: unknown = await response.json();
    if (!schema) return body as T;
    const result = schema.safeParse(body);
    if (!result.success) {
      console.error("Spawn API schema mismatch", { path, issues: result.error.issues });
      throw new ApiError(response.status, "schema_mismatch", "Server response was not valid", {
        issues: result.error.issues,
      });
    }
    return result.data;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
