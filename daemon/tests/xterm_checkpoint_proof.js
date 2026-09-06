// The real-terminal half of the emulator's checkpoint proof. Driven by
// `sessiond::emulator::tests::real_xterm_*` in src/sessiond/emulator.rs, never
// by hand: stdin carries `{ xterm, cols, rows, writes }` — the path of the web
// workspace's @xterm/xterm bundle and the byte strings to write, hex-encoded,
// in order — and stdout is the screen rows after each write, as JSON. The
// bundle runs headless in node exactly as mobile's worker-replay-xterm test
// runs it; the buffer it holds afterwards is what a reader would see.
"use strict";
const { readFileSync } = require("node:fs");

const input = JSON.parse(readFileSync(0, "utf8"));
const { Terminal } = require(input.xterm);
const term = new Terminal({
  rows: input.rows,
  cols: input.cols,
  scrollback: 200,
  allowProposedApi: true,
});

function screenRows() {
  const buffer = term.buffer.active;
  const rows = [];
  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    rows.push(line ? line.translateToString(true) : "");
  }
  return rows;
}

(async () => {
  const observed = [];
  for (const hex of input.writes) {
    await new Promise((done) => term.write(Buffer.from(hex, "hex"), done));
    observed.push(screenRows());
  }
  process.stdout.write(JSON.stringify(observed));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
