# trust-ux — reference implementation

The canonical UX specification lives at [docs/TRUST_UX.md](../../../docs/TRUST_UX.md).
This directory is its reference implementation: pure, props-driven components with basic
styling, one per screen/state, showcased with mock data at `/trust-ux-demo`, plus the
accepted screenshots (`shots/`) and the presentation page (`presentation.html`).

Components map (see the spec's screen/state table): `AccessScreen`, `NumberCheck`,
`WaitingForApproval` / `ApproveRequest` / `ApproveRequestToast`, `PossessHost`,
`RemoveDeviceDialog`, `AccessBlocked`, `TrustHistory`, with primitives in `bits.tsx`
and view-models in `types.ts`.
