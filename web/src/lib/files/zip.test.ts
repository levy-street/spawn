import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Crc32,
  crc32,
  dosDateTime,
  needsZip64End,
  ZipWriter,
  zip64Fields,
  zipEntryName,
} from "./zip";

const encode = (text: string) => new TextEncoder().encode(text);

async function build(
  entries: Array<{ name: string; dir?: boolean; data?: Uint8Array; chunks?: number }>,
  forceZip64 = false,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const writer = new ZipWriter(
    async (bytes) => {
      parts.push(bytes.slice());
    },
    { forceZip64 },
  );
  for (const entry of entries) {
    if (entry.dir) {
      await writer.addDirectory(entry.name, 1_750_000_000);
      continue;
    }
    const data = entry.data ?? new Uint8Array();
    const file = await writer.beginFile(entry.name, { size: data.length, modified: 1_750_000_000 });
    const pieces = Math.max(1, entry.chunks ?? 1);
    const step = Math.ceil(data.length / pieces) || 1;
    for (let at = 0; at < data.length; at += step) await file.write(data.subarray(at, at + step));
    await file.end();
  }
  const length = await writer.finish();
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  expect(at).toBe(length);
  return out;
}

/** A reader of exactly what the writer promises, independent of it. */
function read(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  let zip64End = false;
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    expect(view.getUint32(locator, true)).toBe(0x07064b50);
    const record = Number(view.getBigUint64(locator + 8, true));
    expect(view.getUint32(record, true)).toBe(0x06064b50);
    count = Number(view.getBigUint64(record + 32, true));
    cdSize = Number(view.getBigUint64(record + 40, true));
    cdOffset = Number(view.getBigUint64(record + 48, true));
    zip64End = true;
  }
  const files: Array<{ name: string; data: Uint8Array; directory: boolean; flags: number }> = [];
  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    let offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) {
          size = Number(view.getBigUint64(field, true));
          field += 16;
        }
        if (offset === 0xffffffff) offset = Number(view.getBigUint64(field, true));
      }
      extra += 4 + length;
    }
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localName + localExtra;
    const data = zip.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    if (flags & 0x0008) {
      const descriptor = dataStart + size;
      expect(view.getUint32(descriptor, true)).toBe(0x08074b50);
      expect(view.getUint32(descriptor + 4, true)).toBe(crc);
      const wide = localExtra > 0;
      const described = wide
        ? Number(view.getBigUint64(descriptor + 8, true))
        : view.getUint32(descriptor + 8, true);
      expect(described).toBe(size);
    }
    files.push({ name, data, directory: name.endsWith("/"), flags });
    at = extraEnd;
  }
  expect(at).toBe(cdOffset + cdSize);
  return { files, zip64End };
}

const sample = () => [
  { name: "photos/", dir: true },
  { name: "photos/a.txt", data: encode("hello, world\n"), chunks: 3 },
  { name: "photos/empty.bin", data: new Uint8Array() },
  { name: "photos/naïve café 東京.md", data: encode("# ünïcödé\n") },
  {
    name: "photos/big.bin",
    data: Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) % 251),
    chunks: 7,
  },
];

test("CRC-32 matches the standard check value", () => {
  expect(crc32(encode("123456789"))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
  const split = new Crc32();
  split.update(encode("1234"));
  split.update(encode("56789"));
  expect(split.digest()).toBe(0xcbf43926);
});

test("DOS times keep the reader's clock and clamp before 1980", () => {
  const when = new Date(2026, 9, 4, 13, 45, 31);
  const { date, time } = dosDateTime(when.getTime() / 1000);
  expect(date >> 9).toBe(2026 - 1980);
  expect((date >> 5) & 0xf).toBe(10);
  expect(date & 0x1f).toBe(4);
  expect(time >> 11).toBe(13);
  expect((time >> 5) & 0x3f).toBe(45);
  expect(time & 0x1f).toBe(15);
  expect(dosDateTime(0)).toEqual({ date: (1 << 5) | 1, time: 0 });
  expect(dosDateTime(null)).toEqual({ date: (1 << 5) | 1, time: 0 });
});

test("entry names never climb out of the folder they unpack into", () => {
  expect(zipEntryName(["photos", "a.txt"])).toBe("photos/a.txt");
  expect(zipEntryName(["photos"], true)).toBe("photos/");
  expect(zipEntryName(["..", "x", ".", "", "y"])).toBe("x/y");
  expect(zipEntryName(["a\\b"])).toBe("a_b");
  expect(zipEntryName(["/etc/passwd"])).toBe("etc/passwd");
  expect(() => zipEntryName(["..", "."])).toThrow();
});

test("Zip64 is used exactly where a classic field overflows", () => {
  expect(zip64Fields({ size: 10, offset: 10 })).toEqual({ size: false, offset: false });
  expect(zip64Fields({ size: 0xffffffff, offset: 0 })).toEqual({ size: true, offset: false });
  expect(zip64Fields({ size: 1, offset: 5 * 1024 ** 3 })).toEqual({ size: false, offset: true });
  expect(zip64Fields({ size: 1, offset: 1 }, true)).toEqual({ size: true, offset: true });
  expect(needsZip64End({ entries: 3, directorySize: 100, directoryOffset: 100 })).toBe(false);
  expect(needsZip64End({ entries: 70_000, directorySize: 100, directoryOffset: 100 })).toBe(true);
  expect(needsZip64End({ entries: 3, directorySize: 100, directoryOffset: 2 ** 33 })).toBe(true);
});

for (const forceZip64 of [false, true]) {
  test(`an archive reads back byte for byte${forceZip64 ? " with every Zip64 record" : ""}`, async () => {
    const entries = sample();
    const zip = await build(entries, forceZip64);
    const { files, zip64End } = read(zip);
    expect(zip64End).toBe(forceZip64);
    expect(files.map((file) => file.name)).toEqual(entries.map((entry) => entry.name));
    for (const [index, entry] of entries.entries()) {
      expect(files[index]?.data).toEqual(entry.data ?? new Uint8Array());
      // Every name is UTF-8 flagged; only files carry a descriptor.
      expect((files[index]?.flags ?? 0) & 0x0800).toBe(0x0800);
      expect(Boolean((files[index]?.flags ?? 0) & 0x0008)).toBe(!entry.dir);
    }
  });

  test(`real unzippers accept it${forceZip64 ? " with every Zip64 record" : ""}`, async () => {
    const python = spawnSync("python3", ["--version"]);
    const unzip = spawnSync("unzip", ["-v"]);
    if (python.status !== 0 && unzip.status !== 0) return;
    const entries = sample();
    const zip = await build(entries, forceZip64);
    const dir = mkdtempSync(join(tmpdir(), "spawn-zip-"));
    try {
      const path = join(dir, "test.zip");
      writeFileSync(path, zip);
      if (python.status === 0) {
        const script = [
          "import sys, zipfile, json",
          "z = zipfile.ZipFile(sys.argv[1])",
          "assert z.testzip() is None",
          "print(json.dumps({i.filename: z.read(i).hex() for i in z.infolist()}))",
        ].join("\n");
        const run = spawnSync("python3", ["-c", script, path], { encoding: "utf8" });
        expect(run.stderr).toBe("");
        const read = JSON.parse(run.stdout) as Record<string, string>;
        for (const entry of entries) {
          expect(read[entry.name]).toBe(
            Buffer.from(entry.data ?? new Uint8Array()).toString("hex"),
          );
        }
      }
      if (unzip.status === 0) {
        const run = spawnSync("unzip", ["-t", path], { encoding: "utf8" });
        expect(run.status).toBe(0);
        expect(run.stdout).toContain("No errors detected");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the writer refuses what would make a broken archive", async () => {
  const writer = new ZipWriter(async () => {});
  const entry = await writer.beginFile("a.txt", { size: 3 });
  await expect(writer.beginFile("b.txt", { size: 1 })).rejects.toThrow();
  await expect(entry.write(encode("abcd"))).rejects.toThrow();
  await entry.write(encode("ab"));
  await expect(entry.end()).rejects.toThrow();
  await entry.write(encode("c"));
  await entry.end();
  await expect(writer.beginFile("a.txt", { size: 0 })).rejects.toThrow();
  await expect(writer.addDirectory("folder", null)).rejects.toThrow();
  await writer.finish();
  await expect(writer.addDirectory("late/", null)).rejects.toThrow();
});

test("a whole stream is one entry", async () => {
  const parts: Uint8Array[] = [];
  const writer = new ZipWriter(async (bytes) => {
    parts.push(bytes.slice());
  });
  await writer.addFile("s.txt", new Blob(["streamed ", "bytes"]).stream(), { size: 14 });
  const length = await writer.finish();
  const zip = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    zip.set(part, at);
    at += part.length;
  }
  expect(new TextDecoder().decode(read(zip).files[0]?.data)).toBe("streamed bytes");
});
