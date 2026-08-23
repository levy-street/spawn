export interface FakeApiRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | null;
}

export interface FakeApiResponse {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
  json?: unknown;
  text?: string;
}

export type FakeApiHandler = (
  request: FakeApiRequest,
) => FakeApiResponse | Promise<FakeApiResponse>;

interface FakeApiRoute {
  method: string;
  path: string | RegExp;
  handler: FakeApiHandler;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestValue<T extends "body" | "headers" | "method" | "signal">(
  input: RequestInfo | URL,
  field: T,
): Request[T] | undefined {
  if (typeof input === "string" || input instanceof URL) return undefined;
  return input[field];
}

function responseFrom(value: FakeApiResponse): Response {
  const status = value.status ?? 200;
  const textBody = value.text ?? (value.json === undefined ? "" : JSON.stringify(value.json));
  const encoded = new TextEncoder().encode(textBody);
  const bytes = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: value.statusText ?? "",
    headers: new Headers(value.headers),
    json: async () => value.json,
    text: async () => textBody,
    arrayBuffer: async () => bytes.slice(0),
  } as unknown as Response;
}

function matches(route: FakeApiRoute, request: FakeApiRequest): boolean {
  if (route.method !== request.method) return false;
  const path = `${request.url.pathname}${request.url.search}`;
  if (typeof route.path === "string") {
    return route.path.startsWith("http")
      ? route.path === request.url.toString()
      : route.path === path;
  }
  route.path.lastIndex = 0;
  return route.path.test(path);
}

/** A route-based fetch double that rejects every request not explicitly registered. */
export class FakeApi {
  readonly requests: FakeApiRequest[] = [];
  readonly fetch: typeof fetch;
  private readonly routes: FakeApiRoute[] = [];

  constructor() {
    this.fetch = this.handleFetch.bind(this);
  }

  route(method: string, path: string | RegExp, response: FakeApiResponse | FakeApiHandler): this {
    const handler: FakeApiHandler =
      typeof response === "function" ? response : async () => response;
    this.routes.push({ method: method.toUpperCase(), path, handler });
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.routes.length = 0;
  }

  install(): () => void {
    const original = globalThis.fetch;
    let installed = true;
    globalThis.fetch = this.fetch;
    return () => {
      if (!installed) return;
      installed = false;
      globalThis.fetch = original;
    };
  }

  private async handleFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(requestUrl(input), "https://spawn.test");
    const request: FakeApiRequest = {
      url,
      method: (init.method ?? requestValue(input, "method") ?? "GET").toUpperCase(),
      headers: new Headers(init.headers ?? requestValue(input, "headers")),
      body: init.body ?? requestValue(input, "body") ?? null,
      signal: init.signal ?? requestValue(input, "signal") ?? null,
    };
    this.requests.push(request);
    const route = this.routes.find((candidate) => matches(candidate, request));
    if (!route) {
      throw new Error(
        `Unexpected API request: ${request.method} ${request.url.pathname}${request.url.search}`,
      );
    }
    return responseFrom(await route.handler(request));
  }
}
