/**
 * A streaming, store-only ZIP writer with Zip64, for folder downloads built in
 * the browser.
 *
 * Store-only because the bytes are already on their way through an encrypted
 * channel at a few MB/s at best: deflating them would cost the page CPU and
 * win nothing on the wire, and most of what people zip (photos, video,
 * archives, build output) does not shrink anyway. Streaming because a folder
 * can be gigabytes and must never be held in memory: each entry is written as
 * its bytes arrive, its CRC and size follow it in a data descriptor (general
 * purpose bit 3), and the central directory is written once at the end.
 *
 * Zip64 is used where the classic fields overflow — an archive past 4 GiB, an
 * entry starting past 4 GiB, more than 65,535 entries, an entry of 4 GiB or
 * more — and only there, so a small archive is a plain ZIP every unzipper
 * reads. `forceZip64` writes every Zip64 structure regardless, which is how
 * the tests prove them without writing 4 GiB.
 *
 * Names are UTF-8 (bit 11), `/`-separated, relative, with no `.` or `..`
 * component. Directories are entries ending in `/`. Pure and DOM-free: bytes
 * go to the `write` callback, which applies its own backpressure by awaiting.
 */

const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_EXTRA = 0x0001;

const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** "Made by" Unix (3), spec 4.5: the external attributes carry Unix modes. */
const VERSION_MADE_BY = (3 << 8) | VERSION_ZIP64;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const MAX_NAME_BYTES = 0xffff;
const DIRECTORY_ATTRIBUTES = ((0o40755 << 16) | 0x10) >>> 0;
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC / IEEE 802.3), as ZIP records it. */
export class Crc32 {
  private value = UINT32_MAX;

  update(bytes: Uint8Array): void {
    let c = this.value;
    for (let i = 0; i < bytes.length; i += 1) {
      c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
    }
    this.value = c >>> 0;
  }

  digest(): number {
    return (this.value ^ UINT32_MAX) >>> 0;
  }
}

export function crc32(bytes: Uint8Array): number {
  const crc = new Crc32();
  crc.update(bytes);
  return crc.digest();
}

/**
 * MS-DOS date and time in the reader's own zone, which is what unzippers show.
 * ZIP cannot say anything before 1980; such a time is written as 1980-01-01.
 */
export function dosDateTime(seconds: number | null | undefined): { date: number; time: number } {
  const when =
    typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
  if (!when || when.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 };
  const year = Math.min(when.getFullYear(), 2107);
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
  };
}

/**
 * The archive path for an entry: `/`-joined, every empty, `.` and `..`
 * component dropped (an archive that climbs out of the folder it is unpacked
 * into is how zip-slip happens), and a backslash — legal in a POSIX name,
 * a separator to Windows unzippers — replaced so one name stays one name.
 */
export function zipEntryName(parts: readonly string[], directory = false): string {
  const clean = parts
    .flatMap((part) => part.split("/"))
    .map((part) => part.replaceAll("\\", "_"))
    .filter((part) => part !== "" && part !== "." && part !== "..");
  if (clean.length === 0) throw new Error("A ZIP entry needs a name");
  return `${clean.join("/")}${directory ? "/" : ""}`;
}

/** The fields of an entry that a 32-bit record cannot hold. */
export function zip64Fields(
  entry: { size: number; offset: number },
  force = false,
): { size: boolean; offset: boolean } {
  return {
    size: force || entry.size >= UINT32_MAX,
    offset: force || entry.offset >= UINT32_MAX,
  };
}

/** Whether the end of the archive needs the Zip64 records. */
export function needsZip64End(
  {
    entries,
    directorySize,
    directoryOffset,
  }: {
    entries: number;
    directorySize: number;
    directoryOffset: number;
  },
  force = false,
): boolean {
  return (
    force || entries >= UINT16_MAX || directorySize >= UINT32_MAX || directoryOffset >= UINT32_MAX
  );
}

interface CentralEntry {
  name: Uint8Array;
  directory: boolean;
  date: number;
  time: number;
  crc: number;
  size: number;
  offset: number;
  /** The local header carried a Zip64 extra, so the descriptor is 64-bit. */
  zip64Sizes: boolean;
}

class Bytes {
  private readonly view: DataView;
  readonly bytes: Uint8Array;
  private at = 0;

  constructor(length: number) {
    this.bytes = new Uint8Array(length);
    this.view = new DataView(this.bytes.buffer);
  }
  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }
  u32(value: number): this {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }
  u64(value: number): this {
    this.view.setBigUint64(this.at, BigInt(value), true);
    this.at += 8;
    return this;
  }
  raw(bytes: Uint8Array): this {
    this.bytes.set(bytes, this.at);
    this.at += bytes.length;
    return this;
  }
}

export interface ZipWriterOptions {
  /** Write every Zip64 structure even when nothing overflows (tests). */
  forceZip64?: boolean;
}

/** One file entry being written: bytes in order, then `end`. */
export interface ZipFileWriter {
  write(bytes: Uint8Array): Promise<void>;
  /** Writes the data descriptor. Throws when fewer or more bytes came than declared. */
  end(): Promise<void>;
  /** Bytes written so far. */
  readonly written: number;
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private open: ZipFileWriter | null = null;
  private finished = false;
  private readonly forceZip64: boolean;

  constructor(
    private readonly sink: (bytes: Uint8Array) => Promise<void>,
    options: ZipWriterOptions = {},
  ) {
    this.forceZip64 = options.forceZip64 === true;
  }

  /** Bytes written to the sink so far. */
  get length(): number {
    return this.offset;
  }

  private async emit(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.offset += bytes.length;
    await this.sink(bytes);
  }

  private claim(name: string): Uint8Array {
    if (this.finished) throw new Error("The archive is already finished");
    if (this.open) throw new Error("Finish the open entry before starting another");
    if (this.names.has(name)) throw new Error(`The archive already holds “${name}”`);
    const encoded = new TextEncoder().encode(name);
    if (encoded.length > MAX_NAME_BYTES) throw new Error("A ZIP entry name is too long");
    this.names.add(name);
    return encoded;
  }

  /** A folder entry. `name` comes from `zipEntryName(parts, true)`. */
  async addDirectory(name: string, modified?: number | null): Promise<void> {
    if (!name.endsWith("/")) throw new Error("A ZIP folder name ends in /");
    const encoded = this.claim(name);
    const { date, time } = dosDateTime(modified);
    const offset = this.offset;
    const header = new Bytes(30 + encoded.length)
      .u32(LOCAL_FILE_HEADER)
      .u16(VERSION_DEFAULT)
      .u16(FLAG_UTF8)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(0)
      .u32(0)
      .u32(0)
      .u16(encoded.length)
      .u16(0)
      .raw(encoded);
    await this.emit(header.bytes);
    this.entries.push({
      name: encoded,
      directory: true,
      date,
      time,
      crc: 0,
      size: 0,
      offset,
      zip64Sizes: false,
    });
  }

  /**
   * Start a file entry of exactly `size` bytes. Bytes go through the returned
   * writer, in order and across as many calls as they arrive in; nothing
   * about the entry is final until `end`.
   */
  async beginFile(
    name: string,
    { size, modified }: { size: number; modified?: number | null },
  ): Promise<ZipFileWriter> {
    if (name.endsWith("/")) throw new Error("A ZIP file name does not end in /");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("A ZIP entry needs its size");
    const encoded = this.claim(name);
    const { date, time } = dosDateTime(modified);
    const offset = this.offset;
    const zip64Sizes = zip64Fields({ size, offset }, this.forceZip64).size;
    const extra = zip64Sizes ? 20 : 0;
    const header = new Bytes(30 + encoded.length + extra)
      .u32(LOCAL_FILE_HEADER)
      .u16(zip64Sizes ? VERSION_ZIP64 : VERSION_DEFAULT)
      .u16(FLAG_DATA_DESCRIPTOR | FLAG_UTF8)
      .u16(0)
      .u16(time)
      .u16(date)
      .u32(0)
      .u32(zip64Sizes ? UINT32_MAX : 0)
      .u32(zip64Sizes ? UINT32_MAX : 0)
      .u16(encoded.length)
      .u16(extra)
      .raw(encoded);
    // The sizes follow in the descriptor; the extra only says they are 64-bit.
    if (zip64Sizes) header.u16(ZIP64_EXTRA).u16(16).u64(0).u64(0);
    await this.emit(header.bytes);
    const crc = new Crc32();
    let written = 0;
    let ended = false;
    const writer: ZipFileWriter = {
      get written() {
        return written;
      },
      write: async (bytes) => {
        if (ended) throw new Error("This ZIP entry is already finished");
        if (written + bytes.length > size) throw new Error("More bytes than the entry declared");
        crc.update(bytes);
        written += bytes.length;
        await this.emit(bytes);
      },
      end: async () => {
        if (ended) return;
        if (written !== size) throw new Error("Fewer bytes than the entry declared");
        ended = true;
        const digest = crc.digest();
        const descriptor = new Bytes(zip64Sizes ? 24 : 16).u32(DATA_DESCRIPTOR).u32(digest);
        if (zip64Sizes) descriptor.u64(size).u64(size);
        else descriptor.u32(size).u32(size);
        await this.emit(descriptor.bytes);
        this.entries.push({
          name: encoded,
          directory: false,
          date,
          time,
          crc: digest,
          size,
          offset,
          zip64Sizes,
        });
        this.open = null;
      },
    };
    this.open = writer;
    return writer;
  }

  /** A whole file from a stream, for callers with nothing to resume. */
  async addFile(
    name: string,
    stream: ReadableStream<Uint8Array>,
    options: { size: number; modified?: number | null },
  ): Promise<void> {
    const entry = await this.beginFile(name, options);
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await entry.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    await entry.end();
  }

  /** The central directory and the end records. Returns the archive's length. */
  async finish(): Promise<number> {
    if (this.finished) return this.offset;
    if (this.open) throw new Error("Finish the open entry before the archive");
    this.finished = true;
    const directoryOffset = this.offset;
    for (const entry of this.entries) await this.emit(this.centralHeader(entry));
    const directorySize = this.offset - directoryOffset;
    const count = this.entries.length;
    if (needsZip64End({ entries: count, directorySize, directoryOffset }, this.forceZip64)) {
      const recordOffset = this.offset;
      await this.emit(
        new Bytes(56)
          .u32(ZIP64_END_OF_CENTRAL_DIRECTORY)
          .u64(44)
          .u16(VERSION_MADE_BY)
          .u16(VERSION_ZIP64)
          .u32(0)
          .u32(0)
          .u64(count)
          .u64(count)
          .u64(directorySize)
          .u64(directoryOffset).bytes,
      );
      await this.emit(
        new Bytes(20).u32(ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR).u32(0).u64(recordOffset).u32(1)
          .bytes,
      );
    }
    const many = this.forceZip64 || count >= UINT16_MAX;
    await this.emit(
      new Bytes(22)
        .u32(END_OF_CENTRAL_DIRECTORY)
        .u16(0)
        .u16(0)
        .u16(many ? UINT16_MAX : count)
        .u16(many ? UINT16_MAX : count)
        .u32(this.forceZip64 || directorySize >= UINT32_MAX ? UINT32_MAX : directorySize)
        .u32(this.forceZip64 || directoryOffset >= UINT32_MAX ? UINT32_MAX : directoryOffset)
        .u16(0).bytes,
    );
    return this.offset;
  }

  private centralHeader(entry: CentralEntry): Uint8Array {
    const wide = zip64Fields(entry, this.forceZip64);
    // A folder has no size to widen; its offset may still need it.
    const wideSize = wide.size && !entry.directory;
    const extraFields = (wideSize ? 2 : 0) + (wide.offset ? 1 : 0);
    const extra = extraFields > 0 ? 4 + 8 * extraFields : 0;
    const header = new Bytes(46 + entry.name.length + extra)
      .u32(CENTRAL_DIRECTORY_HEADER)
      .u16(VERSION_MADE_BY)
      .u16(extra > 0 || entry.zip64Sizes ? VERSION_ZIP64 : VERSION_DEFAULT)
      .u16(entry.directory ? FLAG_UTF8 : FLAG_DATA_DESCRIPTOR | FLAG_UTF8)
      .u16(0)
      .u16(entry.time)
      .u16(entry.date)
      .u32(entry.crc)
      .u32(wideSize ? UINT32_MAX : entry.size)
      .u32(wideSize ? UINT32_MAX : entry.size)
      .u16(entry.name.length)
      .u16(extra)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(entry.directory ? DIRECTORY_ATTRIBUTES : FILE_ATTRIBUTES)
      .u32(wide.offset ? UINT32_MAX : entry.offset)
      .raw(entry.name);
    if (extra > 0) {
      header.u16(ZIP64_EXTRA).u16(8 * extraFields);
      if (wideSize) header.u64(entry.size).u64(entry.size);
      if (wide.offset) header.u64(entry.offset);
    }
    return header.bytes;
  }
}
