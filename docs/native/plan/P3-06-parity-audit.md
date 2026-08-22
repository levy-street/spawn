# P3-06 — Parity audit against the 121-capability contract

**Phase 3, parallel with five other agents.** You are the campaign's honest witness.

## 1. Objective

Report, capability by capability, what was built, what was not, and what was built wrong — so the
owner knows exactly what they are testing before they pick up their phone.

## 2. Files you own

```
docs/native/reports/P3-06-parity.md
```

That is all. **You write no product code and fix nothing.** Your value is entirely in being
accurate and unflattering.

## 3. Method

1. Read `research/06-feature-inventory.md`'s full table: 121 numbered capabilities
   (58 core, 56 secondary, 7 desktop-only-by-nature with required phone equivalents).
2. Read every report in `docs/native/reports/`.
3. For each capability, **verify against the code**, not against what a report claims. Reports are
   written by agents grading their own work; find the file, read it, confirm it. A claim you did
   not verify is recorded as unverified, not as done.
4. Classify each: **Done** / **Partial** (with what is missing) / **Not built** (with why) /
   **Not applicable on phone** (with the shipped equivalent).

## 4. The report

- A summary table: counts per classification, split core/secondary/desktop-only.
- The full 121-row table: `F-` number, capability, classification, owning agent, file evidence
  (path:line), notes.
- **Top risks for device testing**: the things most likely to fail on the owner's first run,
  ranked. Lead with the terminal secure-context question (`00-OVERVIEW.md §3 D3`, R-1).
- **Cross-cutting concerns** you noticed reading everything: inconsistencies between agents,
  duplicated logic, contradictory assumptions, interfaces that drifted from `00-OVERVIEW.md §7`.
- A short **"what I would build next"** list, ordered by user impact.

## 5. Rules
- Do not fix anything. Do not edit product code. Do not open a file to "just tidy" it.
- Do not soften findings. If a headline feature is a stub, say it is a stub in the summary, not in
  a footnote.
- Distinguish "not built" from "built and unverifiable without a device" — they are very different
  facts for the owner.

## 6. Deliverables checklist
- [ ] All 121 capabilities classified against code evidence, not reports
- [ ] Summary counts
- [ ] Ranked device-testing risk list
- [ ] Cross-cutting findings
- [ ] Prioritised next-steps list

## 7. Reporting
Progress `docs/native/progress/P3-06.md`; the audit itself is
`docs/native/reports/P3-06-parity.md`.
