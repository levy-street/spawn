# Source guard policy

Repository source guards enforce surfaces that are deterministic without
interpreting human language. Appropriate targets include machine-readable task
rows, schemas, routes, protocol/API literals, required files, and small explicit
lists of forbidden production surfaces.

Source guards must not parse or classify English semantics. They must not build
a Markdown/HTML rendering model, infer grammatical subjects or tense, maintain
a generated prose inventory, or treat wording heuristics as a security proof.
Documentation claims are checked by human review against implementation and
acceptance evidence. A literal guard passing means only that its named source
markers are present or absent.

The interrupted complex guard experiments are retained for audit history on
`backup/p2-data-guard-interrupted-20260716` and
`backup/p2-host-guard-interrupted-20260716`. Those backup branches, and the
complex guard commits on `review/p2-data-design`, are intentionally not merge or
cherry-pick candidates. Useful design prose must be salvaged selectively without
the Python prose parser, generated inventory, or parser dependencies.

The permanent tmux-removal boundary is unchanged. Production tmux execution,
backend selection, session protocol fields, and compatibility fallback remain
literal forbidden surfaces under `scripts/check-worker-only-daemon.sh`. A tmux
bug is translated into the equivalent worker-only behavior; restoring tmux
requires a new ADR and explicit trust-boundary review.

`scripts/check-durable-data-decision.sh` follows this policy: it checks exact
DATA/P3 ledger statuses, canonical DATA declarations, required documentation,
and a short forbidden-file/phrase set. It does not approve P2-DATA-01, implement
P2-DATA-02, or prove the Phase 2/3 security claims.
