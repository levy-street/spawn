# The ritual spinner

While Claude Code works, its status line reads `✻ Summoning… (12s · esc to
interrupt)`: a glyph that cycles through `· ✢ ✳ ✶ ✻ ✽` and a word Claude Code
picks at random from its `spinnerVerbs` setting. When that word is one of the 72
ritual phrases below, SPAWN D covers the glyph (and the space after it) with a
small animation that belongs to the phrase. Both the browser and the phone do
it.

Nothing changes for anyone who has not chosen these phrases. Claude Code's own
words, and any others, leave the line exactly as Claude Code drew it.

## Turning it on

Put the phrases in Claude Code's settings on the host, in
`~/.claude/settings.json`, and start a new `claude` session:

```json
{
  "spinnerVerbs": {
    "mode": "replace",
    "verbs": [
      "Spawning", "Spawning the horde", "Calling forth the spawn", "Hatching the spawn",
      "Raising the spawn", "Unleashing the spawn",
      "Invoking the daemon", "Waking the daemon", "Binding the daemon", "Feeding the daemon",
      "Bargaining with the daemon", "Whispering to the daemon",
      "Sealing the pact", "Forging the pact", "Striking a pact", "Honoring the pact",
      "Reading the pact", "Binding the pact",
      "Laying the curse", "Weaving the curse", "Speaking the curse", "Deepening the curse",
      "Inscribing the curse", "Lifting the curse",
      "Reading the omens", "Heeding the omen", "Seeking an omen", "Divining the omen",
      "Decoding the omen", "Awaiting an omen",
      "Carving the sigil", "Tracing the sigil", "Charging the sigil", "Etching the sigil",
      "Burning the sigil", "Awakening the sigil",
      "Signing in blood", "Spilling blood", "Offering blood", "Drawing blood",
      "Paying the blood price", "Sealing it in blood",
      "Drawing the pentagram", "Tracing the star", "Closing the circle",
      "Inscribing the pentacle", "Chalking the star", "Completing the pentagram",
      "Stoking hellfire", "Kindling the flames", "Feeding the fire", "Fanning the flames",
      "Lighting the pyre", "Burning bright",
      "Summoning", "Binding the spirit", "Calling up the dead", "Commanding the spirit",
      "Speaking the true name", "Beckoning from beyond",
      "Possessing", "Staring into the void", "Watching from the dark", "Taking hold",
      "Opening the eyes", "Gazing back",
      "Chanting the incantation", "Reciting the litany", "Speaking in tongues",
      "Intoning the dark rite", "Murmuring forbidden words", "Awakening the runes"
    ]
  }
}
```

`"mode": "append"` keeps Claude Code's own words as well; those lines keep the
ordinary glyph. To turn it off, take the phrases out.

## The twelve rituals

Six spell a word in Elder Futhark runes, one rune per frame, then flash the
finished word; every one of their phrases names that word. Six are pictures,
and their phrases describe what the picture shows.

| Ritual | Phrases |
|---|---|
| Runes: SPAWN | Spawning, Spawning the horde, Calling forth the spawn, Hatching the spawn, Raising the spawn, Unleashing the spawn |
| Runes: DAEMON | Invoking the daemon, Waking the daemon, Binding the daemon, Feeding the daemon, Bargaining with the daemon, Whispering to the daemon |
| Runes: PACT | Sealing the pact, Forging the pact, Striking a pact, Honoring the pact, Reading the pact, Binding the pact |
| Runes: CURSE | Laying the curse, Weaving the curse, Speaking the curse, Deepening the curse, Inscribing the curse, Lifting the curse |
| Runes: OMEN | Reading the omens, Heeding the omen, Seeking an omen, Divining the omen, Decoding the omen, Awaiting an omen |
| Runes: SIGIL | Carving the sigil, Tracing the sigil, Charging the sigil, Etching the sigil, Burning the sigil, Awakening the sigil |
| Blood drop | Signing in blood, Spilling blood, Offering blood, Drawing blood, Paying the blood price, Sealing it in blood |
| Pentagram, traced line by line | Drawing the pentagram, Tracing the star, Closing the circle, Inscribing the pentacle, Chalking the star, Completing the pentagram |
| Pixel flame | Stoking hellfire, Kindling the flames, Feeding the fire, Fanning the flames, Lighting the pyre, Burning bright |
| Triangle of art | Summoning, Binding the spirit, Calling up the dead, Commanding the spirit, Speaking the true name, Beckoning from beyond |
| Demon eyes | Possessing, Staring into the void, Watching from the dark, Taking hold, Opening the eyes, Gazing back |
| Rune circle | Chanting the incantation, Reciting the litany, Speaking in tongues, Intoning the dark rite, Murmuring forbidden words, Awakening the runes |

No rune word repeats a letter back to back: in a single cell a doubled rune
cannot be told apart from a held one.

## How it works

The table, the detection and the drawing live in one plain-JS module,
`web/src/components/terminal/ritual-spinner.mjs`. The web terminal imports it;
the phone's terminal worker inlines it at build time
(`mobile/src/terminal/worker/build-worker.mjs`), so the two cannot drift.

- **Reading the screen.** A beat after output settles, the client reads the live
  rows, the same kind of read that finds Claude Code's "Update installed"
  notice. Unlike that read it takes either screen: Claude Code draws its whole
  interface on the alternate screen. It looks for a row whose first non-space
  cell is a spinner glyph, followed by a space and a ritual phrase ending in an
  ellipsis. The daemon and the server never see the text (`docs/TRUST.md`).
- **Drawing.** An xterm decoration two cells wide sits on that line, its
  foreground set to the terminal background so the glyph is hidden even before
  the canvas paints. A canvas inside it plays the ritual at 120 ms a frame.
  xterm 5 hides every decoration while the alternate screen is up, so the
  overlay shows itself again each time xterm renders it, while its line is in
  view. The decoration follows the line as output scrolls, and goes when the
  line stops matching: the turn ended or the word changed.
- **Cost.** Only the foreground terminal animates; a parked web terminal drops
  its overlay. With reduced motion the ritual shows one still frame.
