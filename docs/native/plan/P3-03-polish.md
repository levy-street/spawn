# P3-03 — Motion, haptics and performance audit

**Phase 3, parallel with five other agents.**

**Read first:** `00-OVERVIEW.md` (§5), `research/01-design-system.md §motion`,
`research/08-rn-stack.md §4-5`, `research/09-native-terminal-ux.md §TL;DR 9-10`.

## 1. Objective

Make it feel the way the owner asked: "smooth and slick", with tactile feedback that is consistent
rather than scattered.

## 2. Scope and the ownership problem

You audit the whole app but **own almost none of it**. That is deliberate. Your job is:

1. **Audit** every screen against the motion/haptic/performance spec.
2. **Fix only** what falls inside your own paths, or what is a genuinely trivial, isolated
   correction inside another agent's file **that you record line by line in your report**.
3. **Report** everything else as a prioritised finding.

You may edit another agent's file **only** for: a wrong haptic call, a hard-coded duration or
easing that should come from `@/lib/motion`, a missing `useReducedMotion` guard, or a missing
`memo`/`useCallback` causing a measurable list re-render. Nothing structural. No refactors. No
redesigns. If a fix needs more than a few lines, it is a finding, not a fix.

Files you own outright:
```
src/lib/motion/**        # additions only, coordinating with P1-04's API
docs/native/reports/P3-03.md
```

## 3. Audit checklist

**Motion.** Every animated surface uses the tokens: 150ms `cubic-bezier(0.4,0,0.2,1)` default,
200ms `cubic-bezier(0.32,0.72,0,1)` shell, 220ms sheet translation, dialog fade + 95% scale. **No
invented springs** except in gesture-tracking animations. Reduced motion honoured everywhere.

**Haptics.** Every interaction in `P1-04`'s vocabulary table fires the right haptic, exactly once,
at the right moment — threshold crossing for gestures, not release. No screen imports
`expo-haptics` directly. No double-fires where a component and its parent both fire.

**Performance.** Lists use `FlashList` with stable keys and memoised rows; no inline closures
rebuilding every render in a list row; no store subscription that re-renders a whole list on one
item's change; gesture state stays on the UI thread; the terminal never refits during a keyboard
transition; images sized and cached.

**Consistency.** Same interaction, same feedback, everywhere.

## 4. Tests
Add tests only for code you own. For findings, include a reproduction note instead.

## 5. Deliverables checklist
- [ ] Full audit across every screen, checklist by checklist
- [ ] Trivial in-scope fixes applied, each recorded line by line
- [ ] Prioritised findings list for everything else
- [ ] `typecheck`, `lint`, `test` still clean
- [ ] Progress current; report written

## 6. Reporting
Progress `docs/native/progress/P3-03.md`; report `docs/native/reports/P3-03.md` — a table of
findings with file, line, severity, and whether you fixed it or left it.
