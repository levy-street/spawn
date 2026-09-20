import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { instrumentWorkerHtml } from "./instrument-worker.mjs";

const html = readFileSync(new URL("../assets/terminal/worker.html", import.meta.url), "utf8");
test("probes preserve the actual bundled worker despite embedded HTML strings", () => {
  assert.notEqual(html.indexOf("</body>"), html.lastIndexOf("</body>"));
  const result = instrumentWorkerHtml(
    html,
    "globalThis.headProbe = true;",
    "globalThis.bodyProbe = true;",
  );
  const originalScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const scripts = [...result.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts[1][1], originalScript);
  assert.equal(scripts[2][1], "globalThis.bodyProbe = true;");
  assert.ok(result.endsWith("<script>globalThis.bodyProbe = true;</script></body>\n</html>"));
});

test("invalid probe code fails preparation before compiling the native app", () => {
  assert.throws(() => instrumentWorkerHtml(html, "}", ""), SyntaxError);
  assert.throws(() => instrumentWorkerHtml("<head></head>", "", ""), /boundaries/);
});
