# P2-09 — Alerts, notifications and attention badges

**Phase 2, parallel with nine other agents.**

**Read first:** `00-OVERVIEW.md` (§3 D8, §5, §7.2, §8), then `research/10-realtime-and-alerts.md`
§4 (alerts, claiming, preferences) and §9 (what `expo-notifications` can and cannot do in Expo Go).

## 1. Objective

Surface alerts while the app is running, badge what needs attention, and be honest about what a
backgrounded phone can know.

## 2. Files you own

```
src/components/alerts/**
src/lib/notifications.ts
src/data/queries/alerts.ts
```

`P1-08` owns the alert socket and the alert store; you own presentation.

## 3. Specification

### 3.1 What alerts are

`research/10 §TL;DR 2, 6`: the alert socket has **no cursor, acknowledgement, replay or durable
history**, and delivery is **transient and device-local**. Preferences live locally; cross-tab
claiming only arbitrates sound/haptics/notifications. Visual attention badges derive from
**refreshed session state**, not from stored alerts.

So: badges come from `P1-07`'s `attentionRank`/`displayStatus` over live session data. Alerts drive
transient presentation only. Do not build an alert inbox with history the server cannot supply.

### 3.2 Presentation

- In-app: `P1-02`'s toast for transient alerts, with the alert's session as a tap target that
  routes to `P2-05`'s terminal.
- Badges: on workspace rows, tab strip items and terminal rows — computed by selectors, rendered by
  the owning screens. You provide the badge component and the selector wiring; you do not edit
  their screens. Publish the component API in your report so they can adopt it.
- Haptics per the vocabulary; respect the user's notification preferences and the global haptics
  switch.

### 3.3 Notifications — be honest

`research/10 §TL;DR 9` and `00-OVERVIEW.md §3 D8`: the server has **no APNs, FCM, Expo push or Web
Push** path, and **Expo Go cannot receive remote push**. A suspended or terminated app cannot learn
about new alerts. Therefore:

- Implement **local notifications only** (`expo-notifications`), for alerts received while the app
  is running.
- Request permission at a sensible moment, not on first launch.
- In Settings (`P2-08` renders it, you supply the capability), the push-dependent options show an
  explicit unavailable reason.
- **Do not design or request a server push system.** Record it as a known gap.

## 4. Rules
- No alert persistence beyond the in-memory store.
- Never notify for a session the user is currently looking at.
- Rate-limit notifications so a chatty session cannot spam the tray.

## 5. Tests
- Alert → toast mapping, including dedup and the "currently viewing" suppression.
- Badge computation from selector output, including attention precedence.
- Local notification scheduling respects preferences and the rate limit (fake timers).
- Permission-denied path degrades to in-app only.
- Capability reports unavailable for remote push.

## 6. Deliverables checklist
- [ ] Transient alert presentation with routing to the session
- [ ] Badge component + selector wiring, API published for other agents
- [ ] Local notifications with permissions, preferences and rate limiting
- [ ] Explicit unavailable capability for remote push
- [ ] Tests green; `typecheck`, `lint` clean; progress + report written

## 7. Reporting
Progress `docs/native/progress/P2-09.md`; report `docs/native/reports/P2-09.md` with the badge
component API for `P2-03`/`P2-04` to adopt.
