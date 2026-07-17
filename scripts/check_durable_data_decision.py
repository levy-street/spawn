#!/usr/bin/env python3
"""Structured guard for the P2-DATA-01 durable protected-data decision."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import tempfile
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path


class GuardError(RuntimeError):
    pass


class ContradictionError(GuardError):
    def __init__(self, category: str, path: Path, detail: str) -> None:
        self.category = category
        super().__init__(
            f"{path} contains unapproved active prose in category {category!r}: {detail}"
        )


@dataclass(frozen=True)
class Section:
    level: int
    title: str
    start: int
    end: int
    body: str


@dataclass(frozen=True)
class CorpusSentence:
    path: str
    location: str
    sentence_index: int
    occurrence: int
    sentence: str

    @property
    def identity(self) -> tuple[str, str, int, int, str]:
        return (
            self.path,
            self.location,
            self.sentence_index,
            self.occurrence,
            self.sentence,
        )


@dataclass(frozen=True)
class InventorySentence:
    record: CorpusSentence
    categories: tuple[str, ...]


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

DECISION_LINK_DOCS = (
    "docs/DESIGN.md",
    "docs/INTERFACE_MATRIX.md",
    "docs/TRUST.md",
    "docs/TRUST_PHASE2.md",
    "docs/TRUST_PHASE2_PROGRESS.md",
    "docs/TRUST_PHASE2_TASKS.md",
    "proto/README.md",
)

PROSE_INVENTORY = "docs/DURABLE_DATA_PROSE_INVENTORY.jsonl"


def active_markdown(path: Path) -> str:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GuardError(f"cannot read {path}: {exc}") from exc
    active: list[str] = []
    fence: str | None = None
    html_comment = False
    inline_ticks: int | None = None
    for line in raw.splitlines():
        fence_match = None if html_comment or inline_ticks else re.match(r"^\s*(```+|~~~+)", line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            active.append("")
            continue
        if fence is not None:
            active.append("")
            continue

        visible: list[str] = []
        index = 0
        while index < len(line):
            if html_comment:
                if line.startswith("-->", index):
                    html_comment = False
                    visible.extend("   ")
                    index += 3
                else:
                    visible.append(" ")
                    index += 1
                continue

            if inline_ticks is None and line.startswith("<!--", index):
                html_comment = True
                visible.extend("    ")
                index += 4
                continue

            if line[index] == "`":
                end = index
                while end < len(line) and line[end] == "`":
                    end += 1
                tick_count = end - index
                if inline_ticks is None:
                    inline_ticks = tick_count
                elif inline_ticks == tick_count:
                    inline_ticks = None
                visible.append(line[index:end])
                index = end
                continue

            visible.append(line[index])
            index += 1
        active.append("".join(visible))
    if fence is not None:
        raise GuardError(f"unclosed Markdown fence in {path}")
    if html_comment:
        raise GuardError(f"unbalanced HTML comment in {path}")
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


def discover_guarded_corpus(root: Path) -> tuple[str, ...]:
    docs = sorted(
        path.relative_to(root).as_posix()
        for path in (root / "docs").rglob("*.md")
        if path.is_file()
    )
    proto = root / "proto/README.md"
    if not proto.is_file():
        raise GuardError(f"cannot read {proto}: file is missing")
    return tuple((*docs, "proto/README.md"))


def prose_category(relative: str) -> str:
    if relative == "docs/DURABLE_SENSITIVE_DATA.md":
        return "data-design-prose"
    if relative.startswith("docs/TRUST"):
        return "trust-model-prose"
    if relative == "proto/README.md":
        return "protocol-prose"
    return "supporting-design-prose"


_DASH_TRANSLATION = str.maketrans(
    {
        "\u058a": "-",
        "\u05be": "-",
        "\u1400": "-",
        "\u1806": "-",
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2015": "-",
        "\u2e17": "-",
        "\u2e1a": "-",
        "\u2e3a": "-",
        "\u2e3b": "-",
        "\u2e40": "-",
        "\u301c": "-",
        "\u3030": "-",
        "\u30a0": "-",
        "\ufe31": "-",
        "\ufe32": "-",
        "\ufe58": "-",
        "\ufe63": "-",
        "\uff0d": "-",
    }
)


def canonical_visible_text(text: str, *, casefold: bool) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_DASH_TRANSLATION)
    text = text.replace("\u00ad", "")
    text = "".join(character for character in text if unicodedata.category(character) != "Cf")
    text = re.sub(r"(?<=\w)-\s+(?=\w)", "-", text)
    text = re.sub(r"\s*-\s*", "-", text)
    text = normalized(text)
    return text.casefold() if casefold else text


def visible_inline_markdown(text: str) -> str:
    code_spans: list[str] = []

    def stash_code(match: re.Match[str]) -> str:
        code_spans.append(match.group(2))
        return f"CODEXINLINECODE{len(code_spans) - 1}TOKEN"

    text = re.sub(r"(`+)(.+?)\1", stash_code, text)
    text = re.sub(r"!\[([^]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"<((?:https?|mailto):[^>]+)>", r"\1", text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = re.sub(
        r"</?(?:p|div|li|tr|td|th|details|summary)\b[^>]*>", " ", text, flags=re.IGNORECASE
    )
    text = re.sub(r"</?[A-Za-z][^>]*>", "", text)
    text = html.unescape(text)
    for delimiter in ("**", "__", "~~"):
        text = text.replace(delimiter, "")
    text = re.sub(r"(?<!\w)([*_])(?=\S)", "", text)
    text = re.sub(r"(?<=\S)([*_])(?!\w)", "", text)
    text = re.sub(r"\\([\\`*{}\[\]()#+.!_>~-])", r"\1", text)
    for index, code in enumerate(code_spans):
        text = text.replace(f"CODEXINLINECODE{index}TOKEN", code)
    return canonical_visible_text(text, casefold=False)


def split_visible_sentences(text: str) -> tuple[str, ...]:
    return tuple(
        canonical_visible_text(candidate, casefold=True)
        for candidate in re.split(r"(?<=[.!?])\s+(?=\S)", text)
        if canonical_visible_text(candidate, casefold=True)
    )


def corpus_sentences(root: Path, relative: str) -> tuple[CorpusSentence, ...]:
    path = root / relative
    text = active_markdown(path)
    heading_stack: list[tuple[int, str]] = []
    block_ordinals: Counter[tuple[tuple[str, ...], str]] = Counter()
    blocks: list[tuple[tuple[str, ...], str, int, str]] = []
    block_lines: list[str] = []
    block_kind = "paragraph"
    block_section: tuple[str, ...] = ()

    def section_path() -> tuple[str, ...]:
        return tuple(title for _, title in heading_stack)

    def add_block(section: tuple[str, ...], kind: str, source: str) -> None:
        visible = visible_inline_markdown(source)
        if not visible:
            return
        key = (section, kind)
        block_ordinals[key] += 1
        blocks.append((section, kind, block_ordinals[key], visible))

    def flush_block() -> None:
        nonlocal block_kind, block_section
        if block_lines:
            add_block(block_section, block_kind, " ".join(block_lines))
            block_lines.clear()
        block_kind = "paragraph"
        block_section = section_path()

    block_section = section_path()
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        raw_line = lines[index]
        stripped = raw_line.strip()
        if not stripped:
            flush_block()
            index += 1
            continue

        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
        if heading:
            flush_block()
            level = len(heading.group(1))
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            title = visible_inline_markdown(heading.group(2))
            add_block(section_path(), f"heading-{level}", title)
            heading_stack.append((level, canonical_visible_text(title, casefold=True)))
            block_section = section_path()
            index += 1
            continue

        setext = re.fullmatch(r"(=+|-+)", stripped)
        if setext and block_lines and len(block_lines) == 1 and block_kind == "paragraph":
            title_source = block_lines.pop()
            parent = block_section
            level = 1 if stripped.startswith("=") else 2
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            title = visible_inline_markdown(title_source)
            add_block(parent, f"heading-{level}", title)
            heading_stack.append((level, canonical_visible_text(title, casefold=True)))
            block_section = section_path()
            index += 1
            continue

        if re.fullmatch(r"(?:-{3,}|\*{3,}|_{3,})", stripped):
            flush_block()
            index += 1
            continue
        if re.match(r"^\[[^]]+\]:\s+\S+", stripped):
            flush_block()
            index += 1
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            flush_block()
            if not re.fullmatch(r"\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?", stripped):
                add_block(section_path(), "table-row", stripped)
            index += 1
            continue

        blockquote = re.match(r"^\s*(?:>\s*)+(.+)$", raw_line)
        if blockquote:
            if block_lines and block_kind != "blockquote":
                flush_block()
            if not block_lines:
                block_kind = "blockquote"
                block_section = section_path()
            block_lines.append(blockquote.group(1).strip())
            index += 1
            continue

        list_item = re.match(r"^\s*(?:[-+*]|\d+[.)])\s+(.+)$", raw_line)
        if list_item:
            flush_block()
            block_kind = "list-item"
            block_section = section_path()
            block_lines.append(list_item.group(1).strip())
            index += 1
            continue

        if not block_lines:
            block_section = section_path()
        block_lines.append(stripped)
        index += 1
    flush_block()

    occurrence_counts: Counter[str] = Counter()
    records: list[CorpusSentence] = []
    for section, kind, block_ordinal, visible in blocks:
        location = (
            f"{json.dumps(section, ensure_ascii=False, separators=(',', ':'))}"
            f"::{kind}[{block_ordinal}]"
        )
        for sentence_index, sentence in enumerate(split_visible_sentences(visible), 1):
            occurrence_counts[sentence] += 1
            records.append(
                CorpusSentence(
                    path=relative,
                    location=location,
                    sentence_index=sentence_index,
                    occurrence=occurrence_counts[sentence],
                    sentence=sentence,
                )
            )
    return tuple(records)


def all_corpus_sentences(root: Path) -> tuple[CorpusSentence, ...]:
    return tuple(
        record
        for relative in discover_guarded_corpus(root)
        for record in corpus_sentences(root, relative)
    )


def load_prose_inventory(root: Path) -> tuple[InventorySentence, ...]:
    path = root / PROSE_INVENTORY
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise GuardError(f"cannot read {path}: {exc}") from exc

    inventory: list[InventorySentence] = []
    for line_number, line in enumerate(lines, 1):
        try:
            payload = json.loads(line)
        except (TypeError, json.JSONDecodeError) as exc:
            raise GuardError(f"{path}:{line_number} is not valid JSON") from exc
        required = {"path", "location", "sentence_index", "occurrence", "categories", "sentence"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise GuardError(f"{path}:{line_number} has an invalid inventory schema")
        relative = payload["path"]
        categories = payload["categories"]
        if (
            not isinstance(relative, str)
            or not isinstance(payload["location"], str)
            or not isinstance(payload["sentence_index"], int)
            or payload["sentence_index"] < 1
            or not isinstance(payload["occurrence"], int)
            or payload["occurrence"] < 1
            or not isinstance(payload["sentence"], str)
            or not isinstance(categories, list)
            or not categories
            or not all(isinstance(category, str) for category in categories)
        ):
            raise GuardError(f"{path}:{line_number} has invalid inventory values")
        expected_categories = [prose_category(relative)]
        if categories != expected_categories:
            raise GuardError(f"{path}:{line_number} categories must equal {expected_categories}")
        record = CorpusSentence(
            path=relative,
            location=payload["location"],
            sentence_index=payload["sentence_index"],
            occurrence=payload["occurrence"],
            sentence=payload["sentence"],
        )
        if record.sentence != canonical_visible_text(record.sentence, casefold=True):
            raise GuardError(f"{path}:{line_number} sentence is not normalized")
        inventory.append(InventorySentence(record, tuple(categories)))
    if not inventory:
        raise GuardError(f"{path} has no prose inventory")
    identities = [entry.record.identity for entry in inventory]
    if len(identities) != len(set(identities)):
        raise GuardError(f"{path} contains duplicate inventory records")
    return tuple(inventory)


def write_prose_inventory(root: Path) -> None:
    path = root / PROSE_INVENTORY
    lines = []
    for record in all_corpus_sentences(root):
        payload = {
            "path": record.path,
            "location": record.location,
            "sentence_index": record.sentence_index,
            "occurrence": record.occurrence,
            "categories": [prose_category(record.path)],
            "sentence": record.sentence,
        }
        lines.append(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def enforce_prose_inventory(root: Path) -> None:
    inventory = load_prose_inventory(root)
    expected_paths = {entry.record.path for entry in inventory}
    actual_paths = set(discover_guarded_corpus(root))
    if expected_paths != actual_paths:
        added = sorted(actual_paths - expected_paths)
        removed = sorted(expected_paths - actual_paths)
        raise ContradictionError(
            "guarded-corpus",
            root,
            f"guarded Markdown path inventory changed; added={added}, removed={removed}",
        )

    actual = all_corpus_sentences(root)
    expected_by_identity = {entry.record.identity: entry for entry in inventory}
    actual_identities = {record.identity for record in actual}
    expected_identities = set(expected_by_identity)
    unexpected = [record for record in actual if record.identity not in expected_identities]
    if unexpected:
        record = unexpected[0]
        same_location = next(
            (
                entry
                for entry in inventory
                if entry.record.path == record.path
                and entry.record.location == record.location
                and entry.record.sentence_index == record.sentence_index
            ),
            None,
        )
        category = (
            same_location.categories[0]
            if same_location is not None
            else prose_category(record.path)
        )
        raise ContradictionError(
            category,
            root / record.path,
            f"{record.location} sentence {record.sentence_index} occurrence "
            f"{record.occurrence}: {record.sentence}",
        )
    missing = [entry for entry in inventory if entry.record.identity not in actual_identities]
    if missing:
        entry = missing[0]
        record = entry.record
        raise ContradictionError(
            entry.categories[0],
            root / record.path,
            f"missing or relocated {record.location} sentence {record.sentence_index} "
            f"occurrence {record.occurrence}: {record.sentence}",
        )


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


def declaration_map(section: Section, path: Path) -> dict[str, str]:
    declarations: dict[str, str] = {}
    row = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$")
    for line in section.body.splitlines():
        match = row.match(line)
        if not match:
            continue
        key, value = match.groups()
        if key in declarations:
            raise GuardError(f"{path} has duplicate canonical declaration: {key}")
        declarations[key] = value
    return declarations


def validate(root: Path) -> None:
    enforce_prose_inventory(root)
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
        "### Canonical guarded declarations",
        "no server ciphertext schema/API",
        "reconciliation-record presence/detail",
    )
    expected_declarations = {
        "data01_runtime": "design_only_not_implemented",
        "phase2_completion": "incomplete",
        "phase2_canonical_store": "endpoint_local_per_host",
        "phase2_opaque_server_blob_fallback": "forbidden",
        "p2_host_02_status": "reviewed_merged_4e7c89b",
        "acknowledgement_retry_authority": "forbidden",
        "rotation_new_epoch_anchor_slots_before_old_key_retirement": "2",
        "p2_data_02_required_reviewed_merged_dependencies": (
            "P2-DATA-01,P2-HOST-02,P2-TERM-01,P2-HOST-03A"
        ),
        "guarded_active_prose_policy": "exact_visible_sentence_inventory",
        "guarded_active_prose_inventory": "path_location_sentence_occurrence_exact",
    }
    declarations = declaration_map(decision, adr)
    if declarations != expected_declarations:
        raise GuardError(
            f"{adr} canonical declarations mismatch: expected {expected_declarations}, "
            f"found {declarations}"
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
        'A generic successful "set secret" return is not assumed power-loss atomic.',
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

    for relative in DECISION_LINK_DOCS:
        doc = root / relative
        doc_text = active_markdown(doc)
        require(doc_text, doc, "DURABLE_SENSITIVE_DATA.md")

    trust_text = active_markdown(root / "docs/TRUST.md")
    require(
        trust_text,
        root / "docs/TRUST.md",
        "P2-AGENT-02/P2-TERM-02 cut is reviewed and merged at `5722288`",
        "P2-HOST-02 is reviewed and merged at `4e7c89b`",
        "current source has no server-visible host filesystem route/frame",
        "P2-TERM-01 and P2-HOST-03A correction candidates are implemented but independently review-pending, not merged behavior",
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
    for relative in (*discover_guarded_corpus(source), PROSE_INVENTORY):
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
    mutations: list[tuple[str, Callable[[Path], None], str | None]] = []
    positive_mutations: list[tuple[str, Callable[[Path], None]]] = []

    def add_comment_and_fence_decoys(path: Path, safe: str) -> None:
        text = path.read_text(encoding="utf-8")
        decoys = f"<!-- {safe} -->\n\n```text\n{safe}\n```\n\n"
        path.write_text(decoys + text, encoding="utf-8")

    def append_active_claim(path: Path, claim: str, safe_decoy: str) -> None:
        add_comment_and_fence_decoys(path, safe_decoy)
        path.write_text(path.read_text(encoding="utf-8") + f"\n\n{claim}\n", encoding="utf-8")

    def claim_fixture(relative: str, claim: str, safe_decoy: str) -> Callable[[Path], None]:
        def mutate(root: Path) -> None:
            append_active_claim(root / relative, claim, safe_decoy)

        return mutate

    def canonical_html(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        expected = "Spawn will use an **endpoint-local canonical store per host**"
        append_active_claim(
            path,
            "Spawn will use a **server-readable canonical store**.",
            expected,
        )

    def canonical_dead_section(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        expected = "Spawn will use an **endpoint-local canonical store per host**"
        add_comment_and_fence_decoys(path, expected)
        text = path.read_text(encoding="utf-8")
        marker = "## Rejected alternatives"
        text = text.replace(marker, f"{marker}\n\n{expected}\n", 1)
        path.write_text(text + "\n\nThe server is the canonical store.\n", encoding="utf-8")

    def missing_section(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "## Observability contract",
            "## Removed observability text",
        )

    def duplicate_section(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        text = path.read_text(encoding="utf-8")
        text = text.replace(
            "## Rejected alternatives", "## Decision\n\ndecoy\n\n## Rejected alternatives", 1
        )
        path.write_text(text, encoding="utf-8")

    def missing_replay(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "### Durable anti-replay heads and admission",
            "### Temporary retry cache",
        )

    def missing_capacity(root: Path) -> None:
        append_active_claim(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "Request 4,097 may evict an old result before 24 hours.",
            "Request 4,097 fails journal_capacity before effect; settled results remain for 24 hours.",
        )

    def missing_anchor(root: Path) -> None:
        replace_required(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "### Crash-atomic key and anchor storage",
            "### Best-effort anchor storage",
        )

    def missing_data02_dependencies(root: Path) -> None:
        path = root / "docs/TRUST_PHASE2_TASKS.md"
        safe = "P2-DATA-01, P2-HOST-02, P2-TERM-01, P2-HOST-03A (all independently reviewed and merged)"
        replace_required(path, safe, "P2-DATA-01")

    def malformed_markdown(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        path.write_text(path.read_text(encoding="utf-8") + "\n<!-- broken", encoding="utf-8")

    def unreadable_input(root: Path) -> None:
        (root / "docs/INTERFACE_MATRIX.md").unlink()

    def duplicate_inventory_record(root: Path) -> None:
        path = root / PROSE_INVENTORY
        lines = path.read_text(encoding="utf-8").splitlines()
        path.write_text("\n".join((*lines, lines[0])) + "\n", encoding="utf-8")

    def inventory_category_drift(root: Path) -> None:
        path = root / PROSE_INVENTORY
        lines = path.read_text(encoding="utf-8").splitlines()
        payload = json.loads(lines[0])
        payload["categories"] = ["wrong-category"]
        lines[0] = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def new_markdown_fixture(relative: str) -> Callable[[Path], None]:
        def mutate(root: Path) -> None:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# Override\n\nPhase II is done.\n", encoding="utf-8")

        return mutate

    def relocate_safe_sentence(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        source_sentence = "User\nacknowledgement is never retry authority."
        moved_sentence = "User acknowledgement is never retry authority."
        text = path.read_text(encoding="utf-8")
        if source_sentence not in text:
            raise GuardError(f"self-test fixture source missing: {source_sentence}")
        path.write_text(
            text.replace(source_sentence, "", 1) + f"\n\n{moved_sentence}\n",
            encoding="utf-8",
        )

    def duplicate_safe_sentence(root: Path) -> None:
        append_active_claim(
            root / "docs/DURABLE_SENSITIVE_DATA.md",
            "User acknowledgement is never retry authority.",
            "User acknowledgement is never retry authority.",
        )

    def equivalent_visible_formatting(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        old = (
            "only over the authenticated, host-scoped `spawn.host.ctl` DataChannel. The\n"
            "browser may copy values between two online hosts, but the control plane is not a\n"
            "storage or synchronization participant."
        )
        new = (
            "only over the authenticated, host‑scoped `spawn.host.ctl` DataChannel. The browser\n"
            "may copy values between two online hosts, but the <em>control</em> plane is not a storage\n"
            "or synchronization participant."
        )
        replace_required(path, old, new)

    adr_path = "docs/DURABLE_SENSITIVE_DATA.md"
    phase2_path = "docs/TRUST_PHASE2.md"
    tasks_path = "docs/TRUST_PHASE2_TASKS.md"
    runtime_safe = (
        "Status: proposed for independent review; runtime not implemented; Phase 2 incomplete."
    )
    opaque_safe = (
        "Opaque client-encrypted server blobs are not selected and are forbidden "
        "as a Phase 2 fallback."
    )
    host02_safe = "P2-HOST-02 is reviewed and merged at 4e7c89b."
    ack_safe = "User acknowledgement is never retry authority; dismissal preserves the lock."
    rotation_safe = (
        "The old epoch remains until both new-epoch anchor slots and all wrappers are verified."
    )
    data02_safe = "P2-DATA-02 remains blocked until reviewed and merged P2-TERM-01 and P2-HOST-03A."

    mutations.extend(
        (
            (
                "active canonical-store contradiction with active safe declaration and HTML/fence decoys",
                canonical_html,
                "data-design-prose",
            ),
            (
                "active canonical-store paraphrase with active safe and dead-section decoy",
                canonical_dead_section,
                "data-design-prose",
            ),
            ("missing section", missing_section, None),
            ("duplicate section", duplicate_section, None),
            (
                "acknowledgement unlock exact reviewer phrase",
                claim_fixture(
                    adr_path,
                    "User acknowledgement or dismissal unlocks the effect and permits retry.",
                    ack_safe,
                ),
                "data-design-prose",
            ),
            (
                "dismiss then try again reviewer paraphrase",
                claim_fixture(
                    adr_path,
                    "Dismiss the warning, then try again.",
                    ack_safe,
                ),
                "data-design-prose",
            ),
            ("missing durable replay head", missing_replay, None),
            (
                "unsafe capacity eviction with active safe declaration and decoys",
                missing_capacity,
                "data-design-prose",
            ),
            ("missing crash anchor", missing_anchor, None),
            (
                "HOST-02 review-candidate heading with active safe declaration and decoys",
                claim_fixture(
                    phase2_path,
                    "## Current source reality (P2-HOST-02 review candidate)",
                    host02_safe,
                ),
                "trust-model-prose",
            ),
            (
                "runtime and Phase 2 combined exact reviewer phrase",
                claim_fixture(
                    adr_path,
                    "The endpoint-local store is currently implemented in production and Phase 2 is complete.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "production runtime exact reviewer phrase",
                claim_fixture(
                    adr_path,
                    "The endpoint-local store is currently implemented in production.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "shipped private persistence paraphrase",
                claim_fixture(
                    adr_path,
                    "The private persistence layer has shipped.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "DATA-02 implementation status claim",
                claim_fixture(
                    adr_path,
                    "P2-DATA-02 is implemented and live.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "live store and achieved Phase 2 reviewer paraphrase",
                claim_fixture(
                    adr_path,
                    "The durable protected-data store is live now; Phase 2 has been achieved.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "finished Phase 2 reviewer phrase",
                claim_fixture(
                    adr_path,
                    "Phase 2 is finished.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "opaque permitted fallback exact reviewer phrases",
                claim_fixture(
                    adr_path,
                    "Opaque server blobs are permitted as a Phase 2 fallback. Phase 2 may fall back to opaque client-encrypted server blobs.",
                    opaque_safe,
                ),
                "data-design-prose",
            ),
            (
                "offline encrypted server fallback paraphrase",
                claim_fixture(
                    adr_path,
                    "Offline encrypted server data is an acceptable fallback.",
                    opaque_safe,
                ),
                "data-design-prose",
            ),
            (
                "HOST-02 awaiting and pending exact reviewer phrases",
                claim_fixture(
                    phase2_path,
                    "P2-HOST-02 is awaiting review and remains pending. HOST-02 continues to be an unmerged review candidate.",
                    host02_safe,
                ),
                "trust-model-prose",
            ),
            (
                "HOST-02 review outstanding paraphrase",
                claim_fixture(
                    phase2_path,
                    "P2-HOST-02 review is outstanding.",
                    host02_safe,
                ),
                "trust-model-prose",
            ),
            (
                "unsafe one-slot old epoch retirement exact reviewer phrase",
                claim_fixture(
                    adr_path,
                    "The old epoch may be retired after only one slot, before both new-epoch anchor slots are verified.",
                    rotation_safe,
                ),
                "data-design-prose",
            ),
            (
                "previous key either-slot retirement paraphrase",
                claim_fixture(
                    adr_path,
                    "Delete the previous key once either anchor slot is current.",
                    rotation_safe,
                ),
                "data-design-prose",
            ),
            (
                "missing DATA-02 reviewed dependencies with decoys",
                missing_data02_dependencies,
                None,
            ),
            (
                "DATA-02 early-start active claim with active safe declarations and decoys",
                claim_fixture(
                    tasks_path,
                    "P2-DATA-02 may start before P2-TERM-01 and P2-HOST-03A pass independent review.",
                    data02_safe,
                ),
                "trust-model-prose",
            ),
            (
                "unknown but safe runtime wording requires inventory review",
                claim_fixture(
                    adr_path,
                    "The endpoint-local store implementation remains design-only under this revised sentence.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "unknown but safe Phase 2 wording requires inventory review",
                claim_fixture(
                    adr_path,
                    "Phase 2 completion remains governed by the project ledger.",
                    runtime_safe,
                ),
                "data-design-prose",
            ),
            (
                "unknown but safe opaque wording requires inventory review",
                claim_fixture(
                    adr_path,
                    "Opaque server blob fallback status is restated here as forbidden.",
                    opaque_safe,
                ),
                "data-design-prose",
            ),
            (
                "unknown but safe HOST-02 wording requires inventory review",
                claim_fixture(
                    phase2_path,
                    "P2-HOST-02 remains reviewed and merged according to this new sentence.",
                    host02_safe,
                ),
                "trust-model-prose",
            ),
            (
                "unknown but safe acknowledgement wording requires inventory review",
                claim_fixture(
                    adr_path,
                    "Acknowledgement remains outside retry authority in this newly worded sentence.",
                    ack_safe,
                ),
                "data-design-prose",
            ),
            (
                "unknown but safe rotation wording requires inventory review",
                claim_fixture(
                    adr_path,
                    "The old key remains through both anchor slots under this new wording.",
                    rotation_safe,
                ),
                "data-design-prose",
            ),
            (
                "unknown but safe DATA-02 wording requires inventory review",
                claim_fixture(
                    tasks_path,
                    "P2-DATA-02 remains blocked pending dependencies under this new sentence.",
                    data02_safe,
                ),
                "trust-model-prose",
            ),
            ("duplicate prose inventory record is rejected", duplicate_inventory_record, None),
            ("prose inventory category drift is rejected", inventory_category_drift, None),
            (
                "new TRUST override document cannot evade the corpus",
                new_markdown_fixture("docs/TRUST_PHASE2_OVERRIDE.md"),
                "guarded-corpus",
            ),
            (
                "new PHASE2 override document cannot evade the corpus",
                new_markdown_fixture("docs/PHASE2_OVERRIDE.md"),
                "guarded-corpus",
            ),
            (
                "new security model document cannot evade the corpus",
                new_markdown_fixture("docs/SECURITY_MODEL.md"),
                "guarded-corpus",
            ),
            (
                "approved sentence relocation is rejected",
                relocate_safe_sentence,
                "data-design-prose",
            ),
            (
                "approved sentence duplication is rejected",
                duplicate_safe_sentence,
                "data-design-prose",
            ),
            ("malformed Markdown", malformed_markdown, None),
            ("missing parser input", unreadable_input, None),
        )
    )

    normalization_cases = (
        (
            "endpoint-local protected store production claim",
            adr_path,
            "The endpoint-local protected store currently runs in production.",
            runtime_safe,
            "data-design-prose",
            "the endpoint-local protected store currently runs in production.",
        ),
        (
            "Markdown and nonbreaking-hyphen production claim",
            adr_path,
            "The **endpoint‑local protected store** currently ~~runs~~ in <strong>production</strong>.",
            runtime_safe,
            "data-design-prose",
            "the endpoint-local protected store currently runs in production.",
        ),
        (
            "durable endpoint store shipped and serving claim",
            adr_path,
            "The durable endpoint\nstore shipped and is serving production.",
            runtime_safe,
            "data-design-prose",
            "the durable endpoint store shipped and is serving production.",
        ),
        (
            "former master key first replacement anchor claim",
            adr_path,
            "Deleting the `former master key` after the first <em>replacement anchor</em> is permitted.",
            rotation_safe,
            "data-design-prose",
            "deleting the former master key after the first replacement anchor is permitted.",
        ),
        (
            "P2 complete claim",
            adr_path,
            "P2 is complete.",
            runtime_safe,
            "data-design-prose",
            "p2 is complete.",
        ),
        (
            "Phase II done claim",
            adr_path,
            "Phase II is done.",
            runtime_safe,
            "data-design-prose",
            "phase ii is done.",
        ),
        (
            "Unicode em-dash and Roman numeral Phase II claim",
            adr_path,
            "Phase—Ⅱ is done.",
            runtime_safe,
            "data-design-prose",
            "phase-ii is done.",
        ),
        (
            "encrypted control-plane fallback claim",
            adr_path,
            "Encrypted control-plane blobs are a fallback.",
            opaque_safe,
            "data-design-prose",
            "encrypted control-plane blobs are a fallback.",
        ),
        (
            "soft-wrap split control-plane fallback claim",
            adr_path,
            "Encrypted control-\nplane blobs are a fallback.",
            opaque_safe,
            "data-design-prose",
            "encrypted control-plane blobs are a fallback.",
        ),
        (
            "HOST-02 open claim",
            phase2_path,
            "P2-HOST-02 remains open.",
            host02_safe,
            "trust-model-prose",
            "p2-host-02 remains open.",
        ),
        (
            "HTML-split HOST-02 open claim",
            phase2_path,
            "<em>P2-HOST</em>‑02 remains open.",
            host02_safe,
            "trust-model-prose",
            "p2-host-02 remains open.",
        ),
        (
            "user confirmation another attempt claim",
            adr_path,
            "User confirmation permits another attempt.",
            ack_safe,
            "data-design-prose",
            "user confirmation permits another attempt.",
        ),
        (
            "HTML entity user confirmation claim",
            adr_path,
            "User&nbsp;confirmation permits another attempt.",
            ack_safe,
            "data-design-prose",
            "user confirmation permits another attempt.",
        ),
        (
            "legacy epoch slot A claim",
            adr_path,
            "The legacy epoch may be deleted after slot A.",
            rotation_safe,
            "data-design-prose",
            "the legacy epoch may be deleted after slot a.",
        ),
        (
            "DATA-02 before HOST-03A claim",
            tasks_path,
            "P2-DATA-02 may begin before P2-HOST-03A review.",
            data02_safe,
            "trust-model-prose",
            "p2-data-02 may begin before p2-host-03a review.",
        ),
        (
            "HTML-comment tokens inside visible inline code remain active",
            adr_path,
            "The visible code token `<!-- production -->` remains visible.",
            runtime_safe,
            "data-design-prose",
            "the visible code token <!--production--> remains visible.",
        ),
    )

    hidden_hostile_forms = "\n".join(
        (
            "The endpoint-local store is currently implemented in production.",
            "Phase 2 is finished.",
            "Offline encrypted server data is an acceptable fallback.",
            "P2-HOST-02 review is outstanding.",
            "Dismiss the warning, then try again.",
            "Delete the previous key once either anchor slot is current.",
            "P2-DATA-02 may start before P2-TERM-01 and P2-HOST-03A review.",
        )
    )

    def hidden_controlled_claims(root: Path) -> None:
        add_comment_and_fence_decoys(root / adr_path, hidden_hostile_forms)

    positive_mutations.append(
        (
            "comments and fences do not create active controlled sentences",
            hidden_controlled_claims,
        )
    )
    positive_mutations.append(
        (
            "equivalent visible Markdown and Unicode formatting remains accepted",
            equivalent_visible_formatting,
        )
    )

    with tempfile.TemporaryDirectory(prefix="spawn-data-guard-") as temp:
        base = Path(temp)
        for index, (name, mutation, expected_category) in enumerate(mutations):
            fixture = base / str(index)
            copy_fixture(source, fixture)
            mutation(fixture)
            try:
                validate(fixture)
            except ContradictionError as exc:
                if expected_category is not None and exc.category != expected_category:
                    raise GuardError(
                        f"self-test {name!r} expected contradiction category "
                        f"{expected_category!r}, got {exc.category!r}"
                    ) from exc
                continue
            except GuardError as exc:
                if expected_category is not None:
                    raise GuardError(
                        f"self-test {name!r} expected contradiction category "
                        f"{expected_category!r}, but failed for another reason: {exc}"
                    ) from exc
                continue
            raise GuardError(f"self-test mutation unexpectedly passed: {name}")

        normalization_base = base / "normalization"
        for index, (
            name,
            relative,
            claim,
            safe_decoy,
            expected_category,
            expected_detail,
        ) in enumerate(normalization_cases):
            fixture = normalization_base / str(index)
            copy_fixture(source, fixture)
            claim_fixture(relative, claim, safe_decoy)(fixture)
            try:
                validate(fixture)
            except ContradictionError as exc:
                if exc.category != expected_category:
                    raise GuardError(
                        f"normalization self-test {name!r} expected category "
                        f"{expected_category!r}, got {exc.category!r}"
                    ) from exc
                if expected_detail not in str(exc):
                    raise GuardError(
                        f"normalization self-test {name!r} expected visible text "
                        f"{expected_detail!r}, got {exc}"
                    ) from exc
                continue
            except GuardError as exc:
                raise GuardError(
                    f"normalization self-test {name!r} failed for another reason: {exc}"
                ) from exc
            raise GuardError(f"normalization self-test mutation unexpectedly passed: {name}")

        positive_base = base / "positive"
        for index, (name, mutation) in enumerate(positive_mutations):
            fixture = positive_base / str(index)
            copy_fixture(source, fixture)
            mutation(fixture)
            try:
                validate(fixture)
            except GuardError as exc:
                raise GuardError(f"positive self-test {name!r} unexpectedly failed: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--write-inventory", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        if args.self_test and args.write_inventory:
            raise GuardError("--self-test and --write-inventory are mutually exclusive")
        if args.write_inventory:
            write_prose_inventory(root)
            print("durable protected-data prose inventory written")
        elif args.self_test:
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
