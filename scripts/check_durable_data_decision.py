#!/usr/bin/env python3
"""Structured guard for the P2-DATA-01 durable protected-data decision."""

from __future__ import annotations

import argparse
import re
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path


class GuardError(RuntimeError):
    pass


@dataclass(frozen=True)
class Section:
    level: int
    title: str
    start: int
    end: int
    body: str


REQUIRED_H2 = (
    "Decision",
    "Trust boundaries and authorization",
    "Store and cryptographic envelope",
    "Object, conflict, and replay semantics",
    "Limits, availability, and denial of service",
    "Recovery, multi-device, backup, and import",
    "Rotation, revocation, deletion, and purge",
    "Migration and cutover contract for P2-DATA-02",
    "Observability contract",
    "Compatibility failure behavior",
    "Falsifiable acceptance gates",
    "Rejected alternatives",
    "Dependency hand-off",
)

REQUIRED_DOCS = (
    "docs/DESIGN.md",
    "docs/INTERFACE_MATRIX.md",
    "docs/TRUST.md",
    "docs/TRUST_PHASE2.md",
    "docs/TRUST_PHASE2_PROGRESS.md",
    "docs/TRUST_PHASE2_TASKS.md",
    "proto/README.md",
)


def active_markdown(path: Path) -> str:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GuardError(f"cannot read {path}: {exc}") from exc
    if raw.count("<!--") != raw.count("-->"):
        raise GuardError(f"unbalanced HTML comment in {path}")
    raw = re.sub(
        r"<!--.*?-->",
        lambda match: "\n" * match.group(0).count("\n"),
        raw,
        flags=re.DOTALL,
    )

    active: list[str] = []
    fence: str | None = None
    for line in raw.splitlines():
        match = re.match(r"^\s*(```+|~~~+)", line)
        if match:
            marker = match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            active.append("")
            continue
        active.append("" if fence is not None else line)
    if fence is not None:
        raise GuardError(f"unclosed Markdown fence in {path}")
    return "\n".join(active)


def sections(path: Path) -> tuple[str, list[Section]]:
    text = active_markdown(path)
    lines = text.splitlines()
    headings: list[tuple[int, str, int]] = []
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if match:
            headings.append((len(match.group(1)), match.group(2), index))

    parsed: list[Section] = []
    for position, (level, title, start) in enumerate(headings):
        end = len(lines)
        for next_level, _, next_start in headings[position + 1 :]:
            if next_level <= level:
                end = next_start
                break
        parsed.append(Section(level, title, start, end, "\n".join(lines[start + 1 : end])))
    return text, parsed


def normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def unique_section(parsed: list[Section], level: int, title: str, path: Path) -> Section:
    found = [section for section in parsed if section.level == level and section.title == title]
    if len(found) != 1:
        raise GuardError(
            f"{path} requires exactly one level-{level} section {title!r}; found {len(found)}"
        )
    return found[0]


def require(section: Section | str, path: Path, *fragments: str) -> None:
    body = normalized(section.body if isinstance(section, Section) else section)
    for fragment in fragments:
        if normalized(fragment) not in body:
            label = section.title if isinstance(section, Section) else "document"
            raise GuardError(f"{path} section {label!r} lost required decision: {fragment}")


def forbid_patterns(text: str, path: Path, patterns: tuple[str, ...]) -> None:
    body = normalized(text)
    for pattern in patterns:
        if re.search(pattern, body, flags=re.IGNORECASE):
            raise GuardError(f"{path} contains contradictory active prose matching: {pattern}")


def validate(root: Path) -> None:
    adr = root / "docs/DURABLE_SENSITIVE_DATA.md"
    text, parsed = sections(adr)
    for title in REQUIRED_H2:
        unique_section(parsed, 2, title, adr)

    first_h2 = min(section.start for section in parsed if section.level == 2)
    preamble = "\n".join(text.splitlines()[:first_h2])
    require(
        preamble,
        adr,
        "Status: **proposed for independent review; runtime not implemented**.",
    )

    decision = unique_section(parsed, 2, "Decision", adr)
    require(
        decision,
        adr,
        "Spawn will use an **endpoint-local canonical store per host**",
        "Opaque client-encrypted server blobs are **not selected** for Phase 2.",
        "### Exact retained server metadata",
        "no server ciphertext schema/API",
        "reconciliation-record presence/detail",
    )
    forbid_patterns(
        decision.body,
        adr,
        (
            r"server[- ]readable canonical store",
            r"server (?:is|as) (?:the )?canonical (?:store|source)",
            r"server-held (?:decrypt|recovery|store root) key",
        ),
    )

    trust = unique_section(parsed, 2, "Trust boundaries and authorization", adr)
    require(
        trust,
        adr,
        "The server never receives a store root key",
        "Cross-account, cross-host, cross-session, and wrong-version requests fail closed.",
    )

    store = unique_section(parsed, 2, "Store and cryptographic envelope", adr)
    require(
        store,
        adr,
        "### Crash-atomic key and anchor storage",
        "immutable `master-key.<epoch>` records separately from two mutable anchor slots",
        "`anchor.a` and `anchor.b`",
        "`fdatasync`s the file",
        "atomically renames it",
        "fsyncs the containing directory",
        "A generic successful \"set secret\" return is not assumed power-loss atomic.",
        "short writes, disk-full, torn records, rename/fsync failure",
    )

    objects = unique_section(parsed, 2, "Object, conflict, and replay semantics", adr)
    require(
        objects,
        adr,
        "### Durable anti-replay heads and admission",
        "`expected_effect_generation`",
        "root head intentionally serializes Spawn filesystem effects",
        "request 4,097 fails `journal_capacity` before",
        "at least** 24 hours",
        "result-map expiry, daemon restart, or same-lineage restore",
        "### Ambiguous-effect reconciliation",
    )
    forbid_patterns(
        objects.body,
        adr,
        (
            r"expired (?:request )?result.{0,80}(?:is|becomes|may be) (?:new|fresh)",
            r"(?:evict|remove).{0,80}settled result.{0,80}before 24 hours",
        ),
    )

    anti = unique_section(parsed, 3, "Durable anti-replay heads and admission", adr)
    if not (objects.start < anti.start < objects.end):
        raise GuardError(f"{adr}: anti-replay section is outside Object/conflict section")
    ambiguous = unique_section(parsed, 3, "Ambiguous-effect reconciliation", adr)
    if not (objects.start < ambiguous.start < objects.end):
        raise GuardError(f"{adr}: reconciliation section is outside Object/conflict section")
    require(
        ambiguous,
        adr,
        "HOST-02 filesystem mkdir, rename, remove, write, and transfer-destination commit",
        "TERM-01 agent upload commit",
        "HOST-03A tool install",
        "DATA-02 launch/restart",
        "exact account ID, authorized user/principal ID, host ID",
        "root capability identity",
        "backend/worker generation",
        "exact manifest ID/revision/digest",
        "`effect_started` **before** invoking",
        "disk-full, or fsync failure at either pre-effect transition prevents invocation",
        "already durable `effect_started` record remains unresolved",
        "Only a conclusive `not_applied` proof permits a new generation and retry.",
        "User acknowledgement is never retry authority.",
        "dismissal preserves its durable record, anti-replay head, and effect lock",
    )

    limits = unique_section(parsed, 2, "Limits, availability, and denial of service", adr)
    require(
        limits,
        adr,
        "durable external-effect anti-replay heads",
        "cap+1 fails before effect",
        "never remove a current head, tombstone, referenced revision, unresolved reconciliation record",
        "Admission reserves all journal/head/disk capacity before",
    )

    migration = unique_section(parsed, 2, "Migration and cutover contract for P2-DATA-02", adr)
    require(migration, adr, "no dual-read or dual-write", "old binaries fail startup")

    rotation = unique_section(parsed, 2, "Rotation, revocation, deletion, and purge", adr)
    require(
        rotation,
        adr,
        "rewraps every live/historical DEK",
        "every internal reconciliation, idempotency, anti-replay, tombstone, and journal envelope/wrapper",
        "state HMACs under both old and new anchor keys",
        "two consecutive new-epoch anchor advances",
        "**both** A/B slots have been synced, read back, and authenticated under the new epoch",
        "The old master-key epoch may be destroyed only after a final database scan",
        "separate `old_epoch_retire_ready` database/anchor step after the two-slot proof",
        "read-back confirms the old immutable credential is absent",
        "disk-full, crash, rename/fsync failure, or failed read-back at every wrapper",
        "P2-PURGE-01 still inventories and destroys the historical server database",
    )
    forbid_patterns(
        rotation.body,
        adr,
        (
            r"old master-key epoch may be destroyed after (?:the )?first new(?:-epoch)? slot",
            r"destroy(?:s|ed)? the old (?:master )?key after (?:the )?first new(?:-epoch)? slot",
        ),
    )

    compatibility = unique_section(parsed, 2, "Compatibility failure behavior", adr)
    require(
        compatibility,
        adr,
        "acknowledgement/dismissal never unlocks it",
        "fail `journal_capacity` before stream allocation, journal admission, or effect",
        "keep the last valid anchor slot",
    )

    gates = unique_section(parsed, 2, "Falsifiable acceptance gates", adr)
    require(
        gates,
        adr,
        "With 4,096 younger-than-24h settled results, request 4,097 fails before effect",
        "after safe mapping expiry, the old request still fails its durable effect generation",
        "HOST-02 mkdir/rename/remove/write/transfer, TERM-01 upload, HOST-03A install, and DATA-02 launch journals",
        "short-write, disk-full, torn-slot, rename/fsync failure",
        "dismissing the warning, restarting the daemon, or restoring a same-lineage backup cannot unlock",
        "Every interruption retains the old key and recovers a safe authenticated slot.",
        "two consecutive, adjacent A/B slot advances are synced, read back, and authenticated",
        "Mixed-epoch recovery validates the transition under both epoch HMACs.",
        "recorded retire-ready step and deletion read-back must succeed",
    )

    dependency = unique_section(parsed, 2, "Dependency hand-off", adr)
    require(
        dependency,
        adr,
        "P2-DATA-02 is schedulable only after P2-DATA-01 and P2-HOST-02 are reviewed and merged",
        "P2-TERM-01 upload and P2-HOST-03A interactive-tool candidates have each passed independent review and merged",
        "must name the exact reviewed TERM-01/HOST-03A protocol commits",
    )

    active_without_rejected = preamble + "\n" + "\n".join(
        section.body
        for section in parsed
        if section.level == 2 and section.title != "Rejected alternatives"
    )
    forbid_patterns(
        active_without_rejected,
        adr,
        (
            r"user (?:acknowledgement|acknowledgment|dismissal).{0,80}(?:authorizes|permits|releases|unlocks) (?:a )?retry",
            r"(?:acknowledgement|acknowledgment|dismissal).{0,80}(?:releases|clears|removes) (?:the )?(?:effect )?lock",
            r"(?:may|can) evict (?:an? )?(?:unresolved|anti-replay|effect)",
            r"(?:may|can) remove (?:an? )?(?:unresolved record|anti-replay head|effect head)",
            r"(?:endpoint-local|durable protected-data|private) store (?:is|has been|is now) (?:implemented|deployed|live|available at runtime)",
            r"\bruntime (?:is |has been |now )?implemented\b",
            r"(?:P2-DATA-02|DATA-02) (?:is|has been|is now) (?:implemented|done|complete|completed|merged)",
            r"Phase\s*2 (?:is|has been|is now) (?:complete|completed|done|achieved)(?! when\b)",
            r"opaque (?:client-encrypted )?server blobs? (?:are|remain) (?:an? )?allowed (?:Phase\s*2 )?fallback",
            r"opaque (?:client-encrypted )?server blobs? may be (?:used|stored|allowed).{0,50}Phase\s*2",
            r"Phase\s*2 may (?:use|fall back to|store) opaque.{0,40}server blobs?",
            r"server ciphertext (?:is|may be|remains) (?:an? )?(?:allowed |permitted )?(?:Phase\s*2 )?fallback",
            r"(?:P2-)?HOST-02 (?:review candidate|(?:is|remains) (?:an? )?(?:review-pending|review pending|unmerged|not merged|review candidate))",
        ),
    )

    for relative in REQUIRED_DOCS:
        doc = root / relative
        doc_text = active_markdown(doc)
        require(doc_text, doc, "DURABLE_SENSITIVE_DATA.md")
        forbid_patterns(
            doc_text,
            doc,
            (
                r"endpoint-owned or client-encrypted",
                r"retained only at endpoints or as opaque",
                r"opaque endpoint-encrypted blobs are selected",
                r"server[- ]readable canonical store",
                r"(?:endpoint-local|durable protected-data|private) store (?:is|has been|is now) (?:implemented|deployed|live|available at runtime)",
                r"\bruntime (?:is |has been |now )?implemented\b",
                r"(?:P2-DATA-02|DATA-02) (?:is|has been|is now) (?:implemented|done|complete|completed|merged)",
                r"Phase\s*2 (?:is|has been|is now) (?:complete|completed|done|achieved)(?! when\b)",
                r"opaque (?:client-encrypted )?server blobs? (?:are|remain) (?:an? )?allowed (?:Phase\s*2 )?fallback",
                r"opaque (?:client-encrypted )?server blobs? may be (?:used|stored|allowed).{0,50}Phase\s*2",
                r"Phase\s*2 may (?:use|fall back to|store) opaque.{0,40}server blobs?",
                r"server ciphertext (?:is|may be|remains) (?:an? )?(?:allowed |permitted )?(?:Phase\s*2 )?fallback",
                r"(?:P2-)?HOST-02 (?:review candidate|(?:is|remains) (?:an? )?(?:review-pending|review pending|unmerged|not merged|review candidate))",
            ),
        )

    trust_text = active_markdown(root / "docs/TRUST.md")
    require(
        trust_text,
        root / "docs/TRUST.md",
        "P2-AGENT-02/P2-TERM-02 cut is reviewed and merged at `5722288`",
        "P2-HOST-02 is reviewed and merged at `4e7c89b`",
        "current source has no server-visible host filesystem route/frame",
        "P2-TERM-01 and P2-HOST-03A correction candidates are implemented but independently review-pending, not merged behavior",
    )
    forbid_patterns(
        trust_text,
        root / "docs/TRUST.md",
        (r"P2-HOST-02 review candidate", r"P2-HOST-02.{0,80}review/merge pending"),
    )

    phase2_path = root / "docs/TRUST_PHASE2.md"
    phase2_text, phase2_sections = sections(phase2_path)
    unique_section(
        phase2_sections,
        2,
        "Current source reality (reviewed master through `4e7c89b`)",
        phase2_path,
    )
    require(
        phase2_text,
        phase2_path,
        "P2-HOST-02 is reviewed and merged at `4e7c89b`",
        "Current source therefore has no server-visible host filesystem path",
        "P2-HOST-03A has an E2E implementation candidate under independent review; it is not merged",
        "P2-TERM-01 has a direct-upload implementation candidate under independent review; it is not merged",
        "P2-DATA-02 remains blocked until P2-DATA-01, P2-HOST-02, P2-TERM-01, and P2-HOST-03A have each passed independent review and merged",
        "name the exact reviewed TERM-01 upload and HOST-03A tool protocol/effect-boundary commits",
    )
    forbid_patterns(
        phase2_text,
        phase2_path,
        (
            r"Current source reality \(P2-HOST-02 review candidate\)",
            r"filesystem portion is \*\*IMPLEMENTED, REVIEW PENDING\*\* in P2-HOST-02",
            r"interactive tool portion remains planned separately as P2-HOST-03A",
        ),
    )

    tasks = active_markdown(root / "docs/TRUST_PHASE2_TASKS.md")
    require(
        tasks,
        root / "docs/TRUST_PHASE2_TASKS.md",
        "P2-HOST-02 | DONE — REVIEWED, MERGED (`4e7c89b`)",
        "P2-HOST-03A | ACTIVE — IMPLEMENTED, REVIEW PENDING",
        "P2-TERM-01 | ACTIVE — IMPLEMENTED, REVIEW PENDING",
        "P2-DATA-01, P2-HOST-02, P2-TERM-01, P2-HOST-03A (all independently reviewed and merged)",
        "Evidence names the exact reviewed TERM-01/HOST-03A protocol commits and effect boundaries",
    )

    progress = active_markdown(root / "docs/TRUST_PHASE2_PROGRESS.md")
    require(
        progress,
        root / "docs/TRUST_PHASE2_PROGRESS.md",
        "Only after this P2-DATA-01 decision, P2-TERM-01, and P2-HOST-03A have each passed independent review and merged",
        "name the exact reviewed protocol/effect-boundary commits in its evidence",
    )

    proto = active_markdown(root / "proto/README.md")
    require(
        proto,
        root / "proto/README.md",
        "does not advertise a runtime capability today.",
        "`expected_effect_generation`",
        "There is no user-asserted resolution or acknowledgement that authorizes retry.",
    )


def copy_fixture(source: Path, target: Path) -> None:
    for relative in ("docs/DURABLE_SENSITIVE_DATA.md", *REQUIRED_DOCS):
        source_file = source / relative
        target_file = target / relative
        target_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, target_file)


def replace_required(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise GuardError(f"self-test fixture source missing: {old}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def self_test(source: Path) -> None:
    validate(source)
    mutations: list[tuple[str, Callable[[Path], None]]] = []

    def add_comment_and_fence_decoys(path: Path, safe: str) -> None:
        text = path.read_text(encoding="utf-8")
        decoys = f"<!-- {safe} -->\n\n```text\n{safe}\n```\n\n"
        path.write_text(decoys + text, encoding="utf-8")

    def canonical_html(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        expected = "Spawn will use an **endpoint-local canonical store per host**"
        replace_required(path, expected, "Spawn will use a **server-readable canonical store**")
        path.write_text(f"<!-- {expected} -->\n" + path.read_text(encoding="utf-8"), encoding="utf-8")

    def canonical_dead_section(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        expected = "Spawn will use an **endpoint-local canonical store per host**"
        replace_required(path, expected, "Spawn will use a **server-readable canonical store**")
        text = path.read_text(encoding="utf-8")
        marker = "## Rejected alternatives"
        text = text.replace(marker, f"{marker}\n\n{expected}\n", 1)
        path.write_text(text, encoding="utf-8")

    def missing_section(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "## Observability contract",
            "## Removed observability text",
        )

    def duplicate_section(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        text = path.read_text(encoding="utf-8")
        text = text.replace("## Rejected alternatives", "## Decision\n\ndecoy\n\n## Rejected alternatives", 1)
        path.write_text(text, encoding="utf-8")

    def unsafe_ack(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "User\nacknowledgement is never retry authority.",
            "User acknowledgement authorizes retry and releases the effect lock.",
        )

    def missing_replay(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "### Durable anti-replay heads and admission",
            "### Temporary retry cache",
        )

    def missing_capacity(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "request 4,097 fails `journal_capacity`",
            "request 4,097 may evict an old result",
        )

    def missing_anchor(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "### Crash-atomic key and anchor storage",
            "### Best-effort anchor storage",
        )

    def stale_status(root: Path) -> None:
        replace_required(
            root / "docs/TRUST_PHASE2.md",
            "## Current source reality (reviewed master through `4e7c89b`)",
            "## Current source reality (P2-HOST-02 review candidate)",
        )

    def runtime_implemented_claim(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        safe = "Status: **proposed for independent review; runtime not implemented**."
        replace_required(path, safe, "Status: **runtime implemented; endpoint-local store live**.")
        add_comment_and_fence_decoys(path, safe)

    def phase2_complete_claim(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        safe = "Phase 2 remains incomplete."
        add_comment_and_fence_decoys(path, safe)
        path.write_text(path.read_text(encoding="utf-8") + "\n\nPhase 2 is complete.\n", encoding="utf-8")

    def opaque_fallback_claim(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        safe = "Opaque client-encrypted server blobs are **not selected** for Phase 2."
        replace_required(
            path,
            safe,
            "Opaque client-encrypted server blobs are an allowed Phase 2 fallback.",
        )
        add_comment_and_fence_decoys(path, safe)

    def host02_unmerged_claim(root: Path) -> None:
        path = root / "docs/TRUST_PHASE2.md"
        safe = "P2-HOST-02 is reviewed and merged at\n  `4e7c89b`"
        replace_required(path, safe, "P2-HOST-02 is an unmerged review candidate")
        add_comment_and_fence_decoys(path, "P2-HOST-02 is reviewed and merged at `4e7c89b`")

    def unsafe_rotation_retirement(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        safe = "The old master-key epoch may be destroyed only after a final database scan"
        replace_required(
            path,
            safe,
            "The old master-key epoch may be destroyed after the first new-epoch slot",
        )
        add_comment_and_fence_decoys(path, safe)

    def missing_data02_dependencies(root: Path) -> None:
        path = root / "docs/TRUST_PHASE2_TASKS.md"
        safe = "P2-DATA-01, P2-HOST-02, P2-TERM-01, P2-HOST-03A (all independently reviewed and merged)"
        replace_required(path, safe, "P2-DATA-01")
        add_comment_and_fence_decoys(path, safe)

    def malformed_markdown(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        path.write_text(path.read_text(encoding="utf-8") + "\n<!-- broken", encoding="utf-8")

    def unreadable_input(root: Path) -> None:
        (root / "docs/INTERFACE_MATRIX.md").unlink()

    mutations.extend(
        (
            ("HTML-comment canonical decoy", canonical_html),
            ("dead-section canonical decoy", canonical_dead_section),
            ("missing section", missing_section),
            ("duplicate section", duplicate_section),
            ("unsafe acknowledgement", unsafe_ack),
            ("missing durable replay head", missing_replay),
            ("missing capacity rule", missing_capacity),
            ("missing crash anchor", missing_anchor),
            ("stale status", stale_status),
            ("runtime implemented active claim with decoys", runtime_implemented_claim),
            ("Phase 2 complete active claim with decoys", phase2_complete_claim),
            ("opaque Phase 2 fallback active claim with decoys", opaque_fallback_claim),
            ("HOST-02 unmerged active claim with decoys", host02_unmerged_claim),
            ("unsafe first-slot key retirement with decoys", unsafe_rotation_retirement),
            ("missing DATA-02 reviewed dependencies with decoys", missing_data02_dependencies),
            ("malformed Markdown", malformed_markdown),
            ("missing parser input", unreadable_input),
        )
    )

    with tempfile.TemporaryDirectory(prefix="spawn-data-guard-") as temp:
        base = Path(temp)
        for index, (name, mutation) in enumerate(mutations):
            fixture = base / str(index)
            copy_fixture(source, fixture)
            mutation(fixture)
            try:
                validate(fixture)
            except GuardError:
                continue
            raise GuardError(f"self-test mutation unexpectedly passed: {name}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        if args.self_test:
            self_test(root)
            print("durable protected-data decision guard self-test passed")
        else:
            validate(root)
            print("durable protected-data decision guard passed")
    except (GuardError, OSError, UnicodeError, re.error) as exc:
        print(f"durable protected-data decision guard failed: {exc}", file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
