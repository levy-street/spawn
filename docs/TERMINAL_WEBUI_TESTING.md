# Terminal Web UI Testing

The frontend terminal has several automated layers:

- `web/tests/e2e/terminal.spec.ts` covers deterministic protocol and rendering regressions: ANSI color, raw input, control keys, resize, chunked `spawn.ctl` uploads, reconnect, scrollback, alternate screen behavior, mobile touch scrolling, and renderer-level emulation fidelity (emoji two-cell width via Unicode 11, OSC 8 hyperlink underlining without URL leakage, DECSCUSR cursor shapes, OSC 52 clipboard writes).
- `web/tests/e2e/terminal-scrollback-wheel.spec.ts` is a slow-frame regression spec for the wheel-scrollback overlay; it keeps Playwright video/trace recording ON because the recording load is what triggers the underlying xterm.js Viewport NaN race it guards against.
- `tools/term-conformance/` tests grid-level emulation (xterm.js vs oracle terminals) using the exact terminal configuration the web client ships, via the shared module `web/src/components/terminal/xterm-config.mjs`. Change terminal options there, then run `uv run driver.py full-run` in `tools/term-conformance/`.
- `scripts/smoke-local-browser-live.sh` starts the API server, web app, daemon, and a real browser. It verifies a live agent terminal, WebRTC terminal bytes, upload, and second-tab display control.
- `web/tests/e2e/terminal-usability.audit.spec.ts` is an optional recorded Playwright audit for common end-user flows. It uses mocked API data plus fake `spawn.pty` and `spawn.ctl` WebRTC DataChannels so it is fast and deterministic, but records trace/video/screenshot artifacts and attaches a JSON session report. WebSocket traffic in this harness is signaling/lifecycle only; terminal bytes, history, snapshots, input, and viewport controls all use the same mandatory endpoint-channel boundary as production.

## Recorded Usability Audit

Run the audit from `web/`:

```sh
bun run audit:terminal
```

For a visible browser session:

```sh
bun run audit:terminal:headed
```

The audit intentionally stays out of the default `bun run test:e2e` path unless `SPAWN_TERMINAL_AUDIT=1` is set. It records:

- desktop raw terminal typing, Enter, Ctrl-C, resize, file upload, scrollback, live output while scrolled, reconnect, and post-reconnect input
- desktop viewer display-control takeover and typed input
- mobile touch scrollback and modifier-bar Tab, Ctrl-C, and Send behavior
- page console errors, page exceptions, terminal layout boxes, visible text tails, signaling/control counts, and key endpoint-channel events

Playwright writes the HTML report and media under `web/playwright-report/` and `web/test-results/`. Each audit test also writes `terminal-usability-report.json` into its `web/test-results/.../` output directory. Open the HTML report with:

```sh
bunx playwright show-report
```

## Codex Routine

When asked to audit terminal usability, run `bun run audit:terminal` from `web/`, then inspect the Playwright result, attached `terminal-usability-report.json`, screenshots, video, and trace. Report:

- whether the audit passed
- any console/page errors
- failed or suspicious interaction steps
- terminal layout or visibility issues from screenshots/video
- whether the issue reproduces in the mocked audit only or also needs the live smoke: `scripts/smoke-local-browser-live.sh`
