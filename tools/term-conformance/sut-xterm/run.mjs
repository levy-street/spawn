#!/usr/bin/env node
/**
 * SUT runner: apply a corpus case's raw bytes to @xterm/headless and print the
 * final grid state as schema-v1 JSON on stdout.
 *
 * Usage: node run.mjs <bytes-file> --cols 80 --rows 24 --name <case-name>
 *
 * This is the real system under test: web/ renders terminals with @xterm/xterm
 * (same emulation core as @xterm/headless, pinned to the same version here),
 * and this runner instantiates the Terminal with the exact emulation options
 * and Unicode width tables the web client ships, imported from the shared
 * config module in web/ (single source of truth).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import pkg from "@xterm/headless";
import {
  activateUnicodeVersion,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_UNICODE_VERSION,
  XTERM_EMULATION_OPTIONS,
} from "../../../web/src/components/terminal/xterm-config.mjs";

const { Terminal } = pkg;
const require = createRequire(import.meta.url);
const XTERM_VERSION = require("@xterm/headless/package.json").version;

function parseArgs(argv) {
  const args = { cols: 80, rows: 24, name: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cols") args.cols = parseInt(argv[++i], 10);
    else if (a === "--rows") args.rows = parseInt(argv[++i], 10);
    else if (a === "--name") args.name = argv[++i];
    else if (!a.startsWith("--") && args.file === null) args.file = a;
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (!args.file) {
    process.stderr.write("usage: node run.mjs <bytes-file> [--cols N] [--rows N] [--name NAME]\n");
    process.exit(2);
  }
  return args;
}

function colorOf(cell, which) {
  // xterm.js reports exactly what the emulator stores: default, palette index,
  // or 24-bit RGB packed into a number.
  const isDefault = which === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return "default";
  const isPalette = which === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = which === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isPalette) return value;
  return "#" + (value & 0xffffff).toString(16).padStart(6, "0");
}

function serializeCell(cell) {
  const width = cell.getWidth();
  // Unwritten/erased cells hold NUL (""): the schema mandates a single space.
  // Width-0 continuation cells keep text "".
  let text = cell.getChars();
  if (width !== 0 && text === "") text = " ";

  const out = {};
  if (text !== " " || width === 0) out.text = text;
  if (width !== 1) out.width = width;
  const fg = colorOf(cell, "fg");
  const bg = colorOf(cell, "bg");
  if (fg !== "default") out.fg = fg;
  if (bg !== "default") out.bg = bg;
  if (cell.isBold()) out.bold = true;
  if (cell.isDim()) out.dim = true;
  if (cell.isItalic()) out.italic = true;
  if (cell.isUnderline()) out.underline = true;
  if (cell.isInverse()) out.inverse = true;
  if (cell.isStrikethrough()) out.strikethrough = true;
  if (cell.isBlink()) out.blink = true;
  return out;
}

const isDefaultCell = (c) => Object.keys(c).length === 0;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = readFileSync(args.file);

  // The web client's exact emulation config (see web/.../xterm-config.mjs).
  const term = new Terminal({
    ...XTERM_EMULATION_OPTIONS,
    cols: args.cols,
    rows: args.rows,
    scrollback: TERMINAL_SCROLLBACK_LINES,
  });
  activateUnicodeVersion(term, Unicode11Addon);

  let title = "";
  term.onTitleChange((t) => {
    title = t;
  });

  await new Promise((resolve) => term.write(new Uint8Array(data), resolve));

  const buf = term.buffer.active;
  const rows = [];
  for (let y = 0; y < args.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    const row = [];
    if (line) {
      for (let x = 0; x < args.cols; x++) {
        const cell = line.getCell(x);
        row.push(cell ? serializeCell(cell) : {});
      }
    }
    while (row.length > 0 && isDefaultCell(row[row.length - 1])) row.pop();
    rows.push(row);
  }

  // Cursor visibility (DECTCEM) is not part of xterm.js's public buffer API;
  // read the internal core service and degrade to null (= unobservable) if the
  // internals ever move.
  let cursorVisible = null;
  try {
    const coreService = term._core?.coreService ?? term._core?._coreService;
    if (coreService && typeof coreService.isCursorHidden === "boolean") {
      cursorVisible = !coreService.isCursorHidden;
    }
  } catch {
    cursorVisible = null;
  }

  // DECSCUSR updates the public cursorStyle/cursorBlink options (v1.1
  // additive schema fields). "underline" and "bar" map straight through;
  // xterm.js has no other styles.
  const cursorStyle = ["block", "underline", "bar"].includes(term.options.cursorStyle)
    ? term.options.cursorStyle
    : null;

  const state = {
    version: 1,
    producer: { name: "xterm-headless", version: XTERM_VERSION },
    ...(args.name ? { case: args.name } : {}),
    size: { cols: args.cols, rows: args.rows },
    cursor: {
      row: buf.cursorY,
      col: Math.min(buf.cursorX, args.cols - 1),
      visible: cursorVisible,
      style: cursorStyle,
      blink: typeof term.options.cursorBlink === "boolean" ? term.options.cursorBlink : null,
    },
    altScreen: term.buffer.active.type === "alternate",
    title,
    rows,
  };

  process.stdout.write(JSON.stringify(state) + "\n");
  term.dispose();
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(2);
});
