# iTerm2 reference oracle (macOS only)

> **Status: reviewed but unexecuted.** Written against the iTerm2 Python API
> source (`api/library/python/iterm2` @ master) on a Linux machine where it
> cannot run. Expect to shake out small issues on first execution.

`iterm2_runner.py` records grid-state v1 fixtures for every corpus case by
driving a live iTerm2 app: it opens a throwaway window running an inert
`sleep` command, resizes the grid to the case's dimensions, injects the raw
corpus bytes with `Session.async_inject()` (processed as terminal output,
bypassing the child process), waits for the screen to settle, and serializes
`Session.async_get_screen_contents()` — including per-cell `CellStyle`
colors/attributes — to the same schema the SUT emits.

## One-time macOS setup

1. Install iTerm2 ≥ 3.5 (per-cell styles in the Python API require a modern build).
2. iTerm2 → Settings → General → Magic → enable **Python API**.
   Set "Allow all apps to connect" or approve the script on first run.
3. From this directory on the Mac (uv installs the `iterm2` dependency group):

   ```sh
   cd tools/term-conformance
   uv sync --group iterm2
   ```

## Record all fixtures

```sh
# from tools/term-conformance/ (inside a normal terminal, iTerm2 app running)
uv run --group iterm2 python oracle-iterm2/iterm2_runner.py            # -> fixtures/
uv run --group iterm2 python oracle-iterm2/iterm2_runner.py --case wide-cjk
# or via the driver:
uv run --group iterm2 driver.py record-fixtures --oracle iterm2
```

Commit the resulting `fixtures/*.json`. Back on Linux/CI, compare the SUT
against them:

```sh
uv run driver.py run-sut
uv run driver.py compare --expected fixtures --actual out/sut --report reports/xterm-vs-iterm2.txt
```

Note: `known-divergences.json` documents **pyte** divergences only. A fresh
iTerm2 comparison should start from an empty allowlist; add entries only after
manually verifying that a difference is intended iTerm2 behavior.

## Known observability limits (emitted as null = differ wildcard)

- `cursor.visible`: DECTCEM state is not exposed by the API.
- `altScreen`: read best-effort from the `showingAlternateScreen` session
  variable; null if the running iTerm2 doesn't define it.
- Cells styled with "alternate" colors other than default/reversed-default
  (e.g. system messages) report null colors.
