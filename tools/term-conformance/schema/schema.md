# Grid-state schema v1

One JSON document = one snapshot of a terminal's **visible screen** after feeding a corpus
case's raw bytes. Scrollback is out of scope. The formal definition lives in
[`grid-state.schema.json`](grid-state.schema.json) (JSON Schema draft 2020-12).

## Shape

```jsonc
{
  "version": 1,
  "producer": { "name": "xterm-headless", "version": "5.5.0" },
  "case": "sgr-truecolor",
  "size": { "cols": 80, "rows": 24 },
  "cursor": { "row": 3, "col": 10, "visible": true, "style": "block", "blink": false },
  "altScreen": false,
  "title": "",
  "rows": [
    [ { "text": "A", "fg": 1, "bold": true }, {}, { "text": "漢", "width": 2 }, { "text": "", "width": 0 } ],
    []
  ]
}
```

## Rules

- **Coordinates** are 0-based, row 0 = top, col 0 = left. `cursor.col` is clamped to
  `[0, cols-1]`: emulators represent "pending wrap" differently (col == cols vs an
  internal flag), which is not observable grid state, so producers clamp.
- **Compactness.** Serializers omit cell fields equal to defaults (`text: " "`,
  `width: 1`, colors `"default"`, attributes `false`) — a blank cell is `{}` — and may
  trim trailing all-default cells from a row (an untouched row is `[]`). `rows` always
  has exactly `size.rows` entries. Consumers re-normalize before comparing.
- **Colors** are `"default"`, an integer palette index 0–255, or `"#rrggbb"` truecolor.
  Producers report what the emulator actually stores (SGR 31 → index `1`; SGR 38;5;160 →
  index `160`; SGR 38;2;r;g;b → `"#rrggbb"`). The differ compares indexed-vs-truecolor
  semantically for indices ≥ 16 (the 6×6×6 cube + grayscale ramp are standardized);
  indices 0–15 only equal themselves because their RGB values are theme-dependent.
- **Wide characters** occupy a lead cell (`width: 2`, full text) plus a continuation
  cell (`width: 0`, `text: ""`).
- **Combining marks** are stored in the base cell's `text` (e.g. `"é"`). The
  differ compares text NFC-normalized so `"é"` and `"é"` match.
- **Unwritten vs erased cells** both serialize as `" "` (width 1). Erased cells keep
  their background color if the emulator does background-color-erase.
- **Unknowns.** Any nullable field (`title`, `altScreen`, `cursor.visible`,
  `cursor.style`, `cursor.blink`, any cell style field or color) may be `null`, meaning
  the producer cannot observe it. The differ treats null as a wildcard match and
  reports wildcard counts, so a limited oracle degrades transparently instead of
  producing false failures.
- **Cursor style (v1.1 additive).** `cursor.style` (`"block" | "underline" | "bar"`)
  and `cursor.blink` report the DECSCUSR state at snapshot time. Both default to
  `null` (absent = null = unobservable); pyte cannot observe them, xterm reports them
  from its public options. They matter for reattach fidelity: a replayed checkpoint
  must restore the cursor shape the app selected.

## Versioning

`version` is a monotonically increasing integer. Consumers MUST reject documents whose
version they don't know. Fields whose absence is defined as `null`/wildcard (like
`cursor.style`) may be added WITHOUT a version bump: old documents simply wildcard
them. Additive fields with non-wildcard defaults (e.g. a future `underlineStyle`
defaulting to a concrete style) bump the version; fixtures record the version they
were produced with, and the differ refuses to compare mismatched versions. v1 is
intentionally minimal: no scrollback, no hyperlink URLs, no underline color/style,
no protected attributes.
