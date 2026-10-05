/**
 * Test doubles for the transfer engine and hub: a host with v1's rules and
 * an in-memory download sink. Imported only by `*.test.ts`.
 */
import { createHash } from "node:crypto";
import {
  HostControlError,
  type HostDirEntry,
  type HostDirList,
  type HostFileOp,
  type HostFileStat,
  type HostRangeStream,
  type HostReadStream,
} from "@/lib/hostControl";
import type { ByteSink, SinkOpener, TransferHost } from "./transfer-engine";

export const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const text = (value: string) => new TextEncoder().encode(value);
export const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

function streamOf(bytes: Uint8Array, chunk = 4): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A host as the engine sees it: a tree under /home/u with the v1 rules that
 * matter — 96-entry pages, mkdir refusing what exists, writes refusing a
 * taken name unless told to overwrite and committing only a matching digest.
 */
export class FakeHost implements TransferHost {
  readonly files = new Map<string, { bytes: Uint8Array; version: number }>();
  readonly dirs = new Set<string>(["/home/u"]);
  readonly links = new Set<string>();
  capabilities = new Set([
    "fs.list",
    "fs.mkdir",
    "fs.stat",
    "fs.read",
    "fs.read.range",
    "fs.write.begin",
  ]);
  readonly writes: Array<{ dir: string; name: string; overwrite: boolean }> = [];
  readonly ranges: Array<{ path: string; offset: number; length: number }> = [];
  /** Breaks the next stream read from this host after this many bytes. */
  breakReadAfter: number | null = null;
  /** The next write commits, then reports that it could not be sure it did. */
  loseNextCommitAck = false;
  /** Change a file once this many range reads of it have been served. */
  changeAfterRanges: { path: string; after: number } | null = null;
  readonly refuse = new Map<string, string>();
  onBreak: () => void = () => {};

  constructor(readonly name: string) {}

  hasCapability(operation: string): boolean {
    return this.capabilities.has(operation);
  }

  file(path: string, content: string | Uint8Array): this {
    const bytes = typeof content === "string" ? text(content) : content;
    this.files.set(path, { bytes, version: 1 });
    this.mkdirs(path.slice(0, path.lastIndexOf("/")));
    return this;
  }

  dir(path: string): this {
    this.mkdirs(path);
    return this;
  }

  private mkdirs(path: string): void {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) this.dirs.add(`/${parts.slice(0, i).join("/")}`);
  }

  private refused(operation: string, path: string): void {
    const code = this.refuse.get(`${operation}:${path}`);
    if (code) throw new HostControlError(code, code);
  }

  async listPage(path = "/home/u", cursor = 0): Promise<HostDirList> {
    if (!this.dirs.has(path)) throw new HostControlError("not_found");
    const children: HostDirEntry[] = [];
    const childOf = (candidate: string) =>
      candidate.startsWith(`${path}/`) && !candidate.slice(path.length + 1).includes("/");
    for (const dir of this.dirs)
      if (childOf(dir))
        children.push({
          name: dir.slice(path.length + 1),
          path: dir,
          kind: "directory",
          is_dir: true,
        });
    for (const [file, { bytes }] of this.files)
      if (childOf(file))
        children.push({
          name: file.slice(path.length + 1),
          path: file,
          kind: "file",
          is_dir: false,
          size: bytes.length,
          modified_at: 1_700_000_000,
        });
    for (const link of this.links)
      if (childOf(link))
        children.push({
          name: link.slice(path.length + 1),
          path: link,
          kind: "symlink",
          is_dir: false,
        });
    const page = children.slice(cursor, cursor + 96);
    return {
      path,
      home_dir: "/home/u",
      entries: page,
      next_cursor: cursor + 96 < children.length ? cursor + 96 : null,
    };
  }

  async mkdir(path: string): Promise<HostFileOp> {
    this.refused("mkdir", path);
    if (this.dirs.has(path) || this.files.has(path)) throw new HostControlError("already_exists");
    if (!this.dirs.has(path.slice(0, path.lastIndexOf("/"))))
      throw new HostControlError("not_found");
    this.dirs.add(path);
    return { path };
  }

  async stat(path: string): Promise<HostFileStat> {
    const file = this.files.get(path);
    if (file)
      return { path, name: path.split("/").at(-1) ?? "", kind: "file", size: file.bytes.length };
    if (this.dirs.has(path)) return { path, name: path.split("/").at(-1) ?? "", kind: "directory" };
    throw new HostControlError("not_found");
  }

  private stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    const limit = this.breakReadAfter;
    this.breakReadAfter = null;
    if (limit === null) return streamOf(bytes);
    let at = 0;
    return new ReadableStream({
      pull: (controller) => {
        if (at >= limit) {
          this.onBreak();
          controller.error(new HostControlError("connection_closed", "Host control session ended"));
          return;
        }
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(at + 4, limit, bytes.length);
        controller.enqueue(bytes.slice(at, end));
        at = end;
      },
    });
  }

  async readFile(path: string): Promise<HostReadStream> {
    this.refused("read", path);
    const file = this.files.get(path);
    if (!file) throw new HostControlError("not_found");
    return {
      streamId: crypto.randomUUID(),
      path,
      name: path.split("/").at(-1) ?? "",
      length: file.bytes.length,
      sha256: sha(file.bytes),
      stream: this.stream(file.bytes),
    };
  }

  async readRange(path: string, offset: number, length: number): Promise<HostRangeStream> {
    this.refused("read", path);
    this.ranges.push({ path, offset, length });
    const change = this.changeAfterRanges;
    if (change && change.path === path) {
      if (change.after === 0) {
        const current = this.files.get(path);
        if (current) this.files.set(path, { bytes: current.bytes, version: current.version + 1 });
        this.changeAfterRanges = null;
      } else change.after -= 1;
    }
    const file = this.files.get(path);
    if (!file) throw new HostControlError("not_found");
    const slice = file.bytes.slice(offset, offset + length);
    return {
      streamId: crypto.randomUUID(),
      path,
      name: path.split("/").at(-1) ?? "",
      length: slice.length,
      sha256: sha(slice),
      offset,
      fileSize: file.bytes.length,
      version: `v${file.version}`,
      contentType: null,
      openAllowed: false,
      eof: offset + slice.length >= file.bytes.length,
      stream: this.stream(slice),
    };
  }

  async writeStream(
    stream: ReadableStream<Uint8Array>,
    declaration: { dir: string; name: string; length: number; sha256: string; overwrite?: boolean },
    signal?: AbortSignal,
  ): Promise<string> {
    const path = `${declaration.dir}/${declaration.name}`;
    this.refused("write", path);
    if (!this.dirs.has(declaration.dir)) throw new HostControlError("not_found");
    if ((this.files.has(path) || this.dirs.has(path)) && !declaration.overwrite)
      throw new HostControlError("already_exists");
    this.writes.push({
      dir: declaration.dir,
      name: declaration.name,
      overwrite: declaration.overwrite === true,
    });
    const bytes = await readAll(stream);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (bytes.length !== declaration.length || sha(bytes) !== declaration.sha256)
      throw new HostControlError("integrity_mismatch");
    const previous = this.files.get(path);
    this.files.set(path, { bytes, version: (previous?.version ?? 0) + 1 });
    if (this.loseNextCommitAck) {
      this.loseNextCommitAck = false;
      this.onBreak();
      throw new HostControlError("outcome_unknown");
    }
    return path;
  }

  async transferFileTo(
    destination: TransferHost,
    path: string,
    destDir: string,
    overwrite = false,
    signal?: AbortSignal,
    options: {
      name?: string;
      onDeclared?: (source: { name: string; length: number; sha256: string }) => void;
      onProgress?: (bytes: number) => void;
    } = {},
  ): Promise<HostFileOp> {
    const source = await this.readFile(path);
    options.onDeclared?.({ name: source.name, length: source.length, sha256: source.sha256 });
    let relayed = 0;
    const stream = source.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          relayed += chunk.length;
          options.onProgress?.(relayed);
          controller.enqueue(chunk);
        },
      }),
    );
    try {
      const written = await destination.writeStream(
        stream,
        {
          dir: destDir,
          name: options.name ?? source.name,
          length: source.length,
          sha256: source.sha256,
          overwrite,
        },
        signal,
      );
      return { path: written };
    } catch (error) {
      await stream.cancel(error).catch(() => {});
      throw error;
    }
  }
}

export class MemorySink implements SinkOpener {
  readonly limit: number | null = null;
  chunks: Uint8Array[] = [];
  name: string | null = null;
  /** The length it was opened with: what a streamed download would promise the browser. */
  size: number | null | undefined = undefined;
  closed = false;
  aborted = false;
  async open(name: string, size: number | null): Promise<ByteSink> {
    this.name = name;
    this.size = size;
    return {
      write: async (bytes) => {
        this.chunks.push(bytes.slice());
      },
      close: async () => {
        this.closed = true;
      },
      abort: async () => {
        this.aborted = true;
      },
    };
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}
