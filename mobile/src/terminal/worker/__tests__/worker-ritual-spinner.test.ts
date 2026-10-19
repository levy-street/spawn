import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_WORKER_HTML } from "@/terminal/worker/worker-html";

// The ritual spinner is one plain-JS module shared with the web app and
// inlined into the worker by build-worker.mjs. These tests hold the phone to
// the same table and the same behaviour as the browser.
const WEB_SOURCE = resolve(
  __dirname,
  "../../../../../web/src/components/terminal/ritual-spinner.mjs",
);

type RitualSpinnerModule = {
  RITUAL_PHRASES: readonly string[];
  findRitualSpinner: (
    rows: readonly string[],
  ) => { row: number; col: number; ritual: { id: string } } | null;
  createRitualSpinner: unknown;
};

function inlinedModule(): RitualSpinnerModule {
  const start = TERMINAL_WORKER_HTML.indexOf("var SpawnRitualSpinner = (function () {");
  const end = TERMINAL_WORKER_HTML.indexOf("})();", start);
  expect(start).toBeGreaterThan(-1);
  const source = TERMINAL_WORKER_HTML.slice(start, end + "})();".length);
  return new Function(`${source}\nreturn SpawnRitualSpinner;`)() as RitualSpinnerModule;
}

describe("ritual spinner in the terminal worker", () => {
  test("is the web app's module, rebuilt since it last changed", () => {
    const body = readFileSync(WEB_SOURCE, "utf8").replace(/^export (const|function) /gm, "$1 ");
    expect(TERMINAL_WORKER_HTML).toContain(body);
  });

  test("knows the same 72 phrases and finds Claude Code's working line", () => {
    const module = inlinedModule();
    expect(module.RITUAL_PHRASES).toHaveLength(72);
    expect(typeof module.createRitualSpinner).toBe("function");
    const found = module.findRitualSpinner(["", "  ✻ Sealing the pact… (4s · esc to interrupt)"]);
    expect(found).toMatchObject({ row: 1, col: 2, ritual: { id: "pact" } });
    expect(module.findRitualSpinner(["✻ Clauding…"])).toBeNull();
  });

  test("is created with the terminal and read after every settled write", () => {
    expect(TERMINAL_WORKER_HTML).toContain(
      "state.ritualSpinner = SpawnRitualSpinner.createRitualSpinner(terminal)",
    );
    expect(TERMINAL_WORKER_HTML).toContain("state.ritualSpinner?.schedule()");
  });
});
