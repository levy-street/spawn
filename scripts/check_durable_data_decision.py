#!/usr/bin/env python3
"""Structured guard for the P2-DATA-01 durable protected-data decision."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
import time
import unicodedata
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from markdown_it import MarkdownIt
from markdown_it.token import Token


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
    semantic_block_index: int = 0
    hard_boundary_before: bool = False

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


@dataclass(frozen=True)
class StatusPredicateContext:
    linking_verb: str | None
    modal: str | None
    past_auxiliary: bool
    perfect_aspect: bool
    current: bool


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


COMMONMARK = MarkdownIt("commonmark", {"html": True}).enable(["strikethrough", "table"])

# These raw-HTML attributes can render prose visually or expose it through the
# accessibility tree. Include them conservatively even on elements where a
# particular browser would hide the value. Every aria-* value is inventoried:
# some ARIA attributes are identifiers or booleans, but treating those as prose
# is safer than maintaining a bypass-prone per-role attribute list.
VISIBLE_HTML_ATTRIBUTES = frozenset({"alt", "label", "placeholder", "title", "value"})

# CommonMark exposes link/image destinations as href/src attributes, but those
# are not renderer-visible prose. Its title attribute is a visible tooltip and
# must join the exact prose inventory. Image alt text remains token child prose.
VISIBLE_COMMONMARK_ATTRIBUTES = frozenset({"title"})

# Exhaustive child-token policy for the pinned CommonMark inline rules plus the
# enabled strikethrough extension. Escape and entity rules emit text_special;
# it is renderer-visible content, not ignorable parser bookkeeping. Link/image,
# HTML, and breaks have dedicated branches below. Formatting markers are the
# only child tokens that intentionally contribute no characters. Any new token
# type fails closed until this policy and its fixtures are reviewed.
INLINE_VISIBLE_TEXT_TOKEN_TYPES = frozenset({"text", "text_special", "code_inline"})
INLINE_STRUCTURAL_TOKEN_TYPES = frozenset(
    {"em_open", "em_close", "strong_open", "strong_close", "s_open", "s_close"}
)

# Exhaustive top-level token policy for the pinned CommonMark block rules plus
# the enabled table rule. Inline and HTML blocks carry visible prose; fenced and
# indented code are intentionally inactive; every remaining known type is
# structural. Both rendering and corpus inventory validate this set before
# walking tokens so a future block token cannot disappear silently.
BLOCK_VISIBLE_TOKEN_TYPES = frozenset({"inline", "html_block"})
BLOCK_INACTIVE_TOKEN_TYPES = frozenset({"fence", "code_block"})
BLOCK_STRUCTURAL_TOKEN_TYPES = frozenset(
    {
        "paragraph_open",
        "paragraph_close",
        "heading_open",
        "heading_close",
        "blockquote_open",
        "blockquote_close",
        "bullet_list_open",
        "bullet_list_close",
        "ordered_list_open",
        "ordered_list_close",
        "list_item_open",
        "list_item_close",
        "hr",
        "table_open",
        "table_close",
        "thead_open",
        "thead_close",
        "tbody_open",
        "tbody_close",
        "tr_open",
        "tr_close",
        "th_open",
        "th_close",
        "td_open",
        "td_close",
    }
)
SUPPORTED_BLOCK_TOKEN_TYPES = (
    BLOCK_VISIBLE_TOKEN_TYPES
    | BLOCK_INACTIVE_TOKEN_TYPES
    | BLOCK_STRUCTURAL_TOKEN_TYPES
)


class VisibleHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del tag
        for name, value in attrs:
            if value is not None and (
                name in VISIBLE_HTML_ATTRIBUTES or name.startswith("aria-")
            ):
                self.parts.append(value)


def visible_html(source: str) -> str:
    parser = VisibleHtmlParser()
    try:
        parser.feed(source)
        parser.close()
    except Exception as exc:
        raise GuardError(f"invalid active HTML: {exc}") from exc
    return " ".join(parser.parts)


def commonmark_visible_attributes(token: Token) -> tuple[str, ...]:
    return tuple(
        value
        for name in sorted(VISIBLE_COMMONMARK_ATTRIBUTES)
        if (value := token.attrGet(name)) is not None and value
    )


def append_separated(parts: list[str], values: tuple[str, ...]) -> None:
    for value in values:
        parts.extend((" ", value, " "))


def validate_block_token_types(tokens: list[Token]) -> None:
    for token in tokens:
        if token.type not in SUPPORTED_BLOCK_TOKEN_TYPES:
            raise GuardError(f"unsupported CommonMark block token type: {token.type}")


def markdown_tokens(path: Path) -> list[Token]:
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GuardError(f"cannot read {path}: {exc}") from exc
    try:
        tokens = COMMONMARK.parse(source)
    except Exception as exc:
        raise GuardError(f"cannot parse CommonMark in {path}: {exc}") from exc
    for token in tokens:
        if token.type == "fence":
            if token.map is None:
                raise GuardError(f"CommonMark fence token has no source map in {path}")
            start, end = token.map
            marker = token.markup
            if (
                len(marker) < 3
                or marker[0] not in {"`", "~"}
                or marker != marker[0] * len(marker)
            ):
                raise GuardError(f"invalid CommonMark fence token in {path}")
            content_lines = token.content.count("\n")
            if token.content and not token.content.endswith("\n"):
                content_lines += 1
            # markdown-it includes an explicit close in the token span but not
            # in token.content. This relation is invariant under blockquote and
            # list container prefix removal, unlike matching the raw source line.
            if end - start != content_lines + 2:
                raise GuardError(f"unclosed CommonMark fence in {path}")
        candidates = [token, *(token.children or [])]
        for candidate in candidates:
            if candidate.type in {
                "html_block",
                "html_inline",
            } and candidate.content.count("<!--") != candidate.content.count("-->"):
                raise GuardError(f"unbalanced HTML comment in {path}")
    return tokens


def visible_inline_tokens(tokens: list[Token]) -> str:
    parts: list[str] = []
    link_attributes: list[tuple[str, ...]] = []
    for token in tokens:
        if token.type == "link_open":
            link_attributes.append(commonmark_visible_attributes(token))
            continue
        if token.type == "link_close":
            if not link_attributes:
                raise GuardError("malformed CommonMark link token nesting")
            append_separated(parts, link_attributes.pop())
            continue
        if token.type in INLINE_VISIBLE_TEXT_TOKEN_TYPES:
            parts.append(token.content)
        elif token.type in {"softbreak", "hardbreak"}:
            parts.append(" ")
        elif token.type == "html_inline":
            visible = visible_html(token.content)
            if visible:
                append_separated(parts, (visible,))
        elif token.type == "image":
            parts.append(
                visible_inline_tokens(token.children)
                if token.children is not None
                else token.content
            )
            append_separated(parts, commonmark_visible_attributes(token))
        elif token.type in INLINE_STRUCTURAL_TOKEN_TYPES:
            append_separated(parts, commonmark_visible_attributes(token))
        else:
            raise GuardError(f"unsupported CommonMark inline token type: {token.type}")
    if link_attributes:
        raise GuardError("malformed CommonMark link token nesting")
    return canonical_visible_text("".join(parts), casefold=False)


def rendered_blocks(tokens: list[Token]) -> tuple[str, ...]:
    validate_block_token_types(tokens)
    blocks: list[str] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type == "tr_open":
            cells: list[str] = []
            index += 1
            while index < len(tokens) and tokens[index].type != "tr_close":
                if (
                    tokens[index].type == "inline"
                    and tokens[index].children is not None
                ):
                    cells.append(visible_inline_tokens(tokens[index].children))
                index += 1
            row = " | ".join(cell for cell in cells if cell)
            if row:
                blocks.append(row)
        elif token.type == "inline":
            if token.children is None:
                raise GuardError("CommonMark inline block has no child tokens")
            visible = visible_inline_tokens(token.children)
            if visible:
                blocks.append(visible)
        elif token.type == "html_block":
            visible = canonical_visible_text(
                visible_html(token.content), casefold=False
            )
            if visible:
                blocks.append(visible)
        index += 1
    return tuple(blocks)


def active_markdown(path: Path) -> str:
    return "\n".join(rendered_blocks(markdown_tokens(path)))


def active_markdown_prefix(path: Path, token_end: int) -> str:
    return "\n".join(rendered_blocks(markdown_tokens(path)[:token_end]))


def sections(path: Path) -> tuple[str, list[Section]]:
    tokens = markdown_tokens(path)
    text = "\n".join(rendered_blocks(tokens))
    headings: list[tuple[int, str, int, int]] = []
    for index, token in enumerate(tokens):
        if token.type != "heading_open" or index + 1 >= len(tokens):
            continue
        inline = tokens[index + 1]
        if inline.type != "inline" or inline.children is None:
            raise GuardError(f"{path} has a malformed CommonMark heading")
        level = int(token.tag.removeprefix("h"))
        headings.append(
            (level, visible_inline_tokens(inline.children), index, index + 3)
        )

    parsed: list[Section] = []
    for position, (level, title, start, body_start) in enumerate(headings):
        end = len(tokens)
        for next_level, _, next_start, _ in headings[position + 1 :]:
            if next_level <= level:
                end = next_start
                break
        body = "\n".join(rendered_blocks(tokens[body_start:end]))
        parsed.append(Section(level, title, start, end, body))
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
_APOSTROPHE_TRANSLATION = str.maketrans(
    {
        "\u02bc": "'",
        "\u2018": "'",
        "\u2019": "'",
        "\u201b": "'",
        "\uff07": "'",
    }
)


def canonical_visible_text(text: str, *, casefold: bool) -> str:
    text = (
        unicodedata.normalize("NFKC", text)
        .translate(_DASH_TRANSLATION)
        .translate(_APOSTROPHE_TRANSLATION)
    )
    text = text.replace("\u00ad", "")
    text = "".join(
        character for character in text if unicodedata.category(character) != "Cf"
    )
    text = re.sub(r"(?<=\w)-\s+(?=\w)", "-", text)
    text = re.sub(r"\s*-\s*", "-", text)
    text = normalized(text)
    return text.casefold() if casefold else text


def split_visible_sentences(text: str) -> tuple[str, ...]:
    return tuple(
        canonical_visible_text(candidate, casefold=True)
        for candidate in re.split(r"(?<=[.!?])\s+(?=\S)", text)
        if canonical_visible_text(candidate, casefold=True)
    )


def corpus_sentences(root: Path, relative: str) -> tuple[CorpusSentence, ...]:
    path = root / relative
    tokens = markdown_tokens(path)
    validate_block_token_types(tokens)
    heading_stack: list[tuple[int, str]] = []
    block_ordinals: Counter[tuple[tuple[str, ...], str]] = Counter()
    blocks: list[tuple[tuple[str, ...], str, int, str, int, bool]] = []
    list_depth = 0
    blockquote_depth = 0
    semantic_block_index = 0
    hard_boundary_pending = False

    def section_path() -> tuple[str, ...]:
        return tuple(title for _, title in heading_stack)

    def add_block(section: tuple[str, ...], kind: str, visible: str) -> None:
        nonlocal hard_boundary_pending, semantic_block_index
        visible = canonical_visible_text(visible, casefold=False)
        if not visible:
            return
        key = (section, kind)
        block_ordinals[key] += 1
        semantic_block_index += 1
        blocks.append(
            (
                section,
                kind,
                block_ordinals[key],
                visible,
                semantic_block_index,
                hard_boundary_pending,
            )
        )
        hard_boundary_pending = False

    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type in BLOCK_INACTIVE_TOKEN_TYPES or token.type == "hr":
            hard_boundary_pending = True
        if token.type == "heading_open":
            if index + 1 >= len(tokens):
                raise GuardError(f"{path} has a malformed CommonMark heading")
            inline = tokens[index + 1]
            if inline.type != "inline" or inline.children is None:
                raise GuardError(f"{path} has a malformed CommonMark heading")
            level = int(token.tag.removeprefix("h"))
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            title = visible_inline_tokens(inline.children)
            add_block(section_path(), f"heading-{level}", title)
            heading_stack.append((level, canonical_visible_text(title, casefold=True)))
            index += 3
            continue
        if token.type == "tr_open":
            cells: list[str] = []
            index += 1
            while index < len(tokens) and tokens[index].type != "tr_close":
                if (
                    tokens[index].type == "inline"
                    and tokens[index].children is not None
                ):
                    cells.append(visible_inline_tokens(tokens[index].children))
                index += 1
            add_block(section_path(), "table-row", " | ".join(cells))
        elif token.type == "list_item_open":
            list_depth += 1
        elif token.type == "list_item_close":
            list_depth -= 1
        elif token.type == "blockquote_open":
            blockquote_depth += 1
        elif token.type == "blockquote_close":
            blockquote_depth -= 1
        elif token.type == "inline":
            if token.children is None:
                raise GuardError(f"{path} CommonMark inline block has no child tokens")
            kind = (
                "list-item"
                if list_depth
                else "blockquote"
                if blockquote_depth
                else "paragraph"
            )
            add_block(section_path(), kind, visible_inline_tokens(token.children))
        elif token.type == "html_block":
            kind = (
                "list-item"
                if list_depth
                else "blockquote"
                if blockquote_depth
                else "html-block"
            )
            add_block(section_path(), kind, visible_html(token.content))
        index += 1

    occurrence_counts: Counter[str] = Counter()
    records: list[CorpusSentence] = []
    for (
        section,
        kind,
        block_ordinal,
        visible,
        semantic_block_index,
        hard_boundary_before,
    ) in blocks:
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
                    semantic_block_index=semantic_block_index,
                    hard_boundary_before=(hard_boundary_before and sentence_index == 1),
                )
            )
    return tuple(records)


def all_corpus_sentences(root: Path) -> tuple[CorpusSentence, ...]:
    return tuple(
        record
        for relative in discover_guarded_corpus(root)
        for record in corpus_sentences(root, relative)
    )


PREMATURE_DATA_STATUS_WORD = re.compile(
    r"\b(?:approved|accepted|authoritative|selected)\b"
)
DATA_STORE_SUBJECT_PATTERN = (
    r"(?:protected(?:-data)?|durable(?:-data)?|endpoint(?:-local|-owned)?|"
    r"private|canonical)"
    r"(?:\s+[a-z0-9-]+){0,4}\s+store"
)
DATA_STATUS_SUBJECT_PATTERN = (
    r"\b(?:"
    r"p2-data-(?:01|02)|"
    r"data-(?:01|02)(?: decision| design| target| contract| store)?|"
    r"durable protected(?:-data)? (?:state|target|store)|"
    rf"{DATA_STORE_SUBJECT_PATTERN}|"
    r"(?:p2-data-02 )?store contract|"
    r"per-host(?: endpoint-local)?(?: canonical| durable)? store"
    r")\b"
)
DATA_STATUS_SUBJECT = re.compile(DATA_STATUS_SUBJECT_PATTERN)
STATUS_LINKING_VERB = re.compile(
    r"\b(?:is|are|was|were|be|been|being|become|becomes|became|"
    r"remain|remains|remained)\b"
)
STATUS_AUXILIARY = re.compile(
    r"\b(?:do|does|did|may|might|must|will|would|can|could|shall|should)\b"
)
FUTURE_OR_HYPOTHETICAL_MODALS = frozenset(
    {"may", "might", "must", "will", "would", "can", "could", "shall", "should"}
)
FUTURE_OR_HYPOTHETICAL_MODAL = re.compile(
    rf"\b(?:{'|'.join(sorted(FUTURE_OR_HYPOTHETICAL_MODALS))})\b"
)
PAST_TENSE_AUXILIARY = re.compile(r"\b(?:did|had)\b")
STATUS_PREDICATE = re.compile(
    rf"(?:{STATUS_LINKING_VERB.pattern}|{STATUS_AUXILIARY.pattern}|"
    rf"{PREMATURE_DATA_STATUS_WORD.pattern})"
)
GENERIC_NOUN_SUBJECT_PATTERN = r"(?:the|a|an)\s+(?:[a-z0-9-]+\s+){0,7}[a-z0-9-]+"
IDENTIFIER_SUBJECT_PATTERN = r"(?:p2-[a-z0-9-]+|data-(?:01|02))"
PRONOUN_SUBJECT_PATTERN = r"(?:it|this|that|they|these|those)"
EXPLICIT_CLAUSE_SUBJECT_PATTERN = (
    rf"(?:{GENERIC_NOUN_SUBJECT_PATTERN}|{IDENTIFIER_SUBJECT_PATTERN}|"
    rf"{PRONOUN_SUBJECT_PATTERN})"
)
COMPLETE_CLAUSE_START = re.compile(
    rf"^\s*(?:either\s+)?{EXPLICIT_CLAUSE_SUBJECT_PATTERN}"
    rf"(?:\s+(?:and|or)\s+{EXPLICIT_CLAUSE_SUBJECT_PATTERN})*"
    rf"\s+(?:{STATUS_LINKING_VERB.pattern}|{STATUS_AUXILIARY.pattern}|"
    rf"{PREMATURE_DATA_STATUS_WORD.pattern})"
)
STRONG_STATUS_CLAUSE_BOUNDARY = re.compile(
    r"\s*(?:;|:)\s*|\s*,?\s*\b(?:but|however|whereas)\b\s*|"
    r"\s*,\s*\byet\b\s*"
)
CONDITIONAL_STATUS_CLAUSE_BOUNDARY = re.compile(r"\b(?:and|or|before|after|while)\b")
NON_GOVERNING_SUBJECT_REFERENCE = re.compile(
    r"\([^)]*\b(?:unlike|like|compared (?:with|to)|as opposed to|not|"
    r"rather than|instead of)\b[^)]*\)|"
    r",\s*(?:unlike|like|compared (?:with|to)|as opposed to|not|"
    r"rather than|instead of)\b[^,]*,|"
    r"^\s*(?:unlike|compared (?:with|to)|in contrast (?:with|to))\b[^,]*,|"
    rf"-\s*(?:unlike|like|compared (?:with|to)|as opposed to|not)\b.*?-"
    rf"(?=(?:{STATUS_LINKING_VERB.pattern}|{STATUS_AUXILIARY.pattern}))|"
    rf"^\s*(?:between|among)\b.*,\s*(?=(?:(?:only|solely)\s+)?"
    rf"{EXPLICIT_CLAUSE_SUBJECT_PATTERN}(?:\s+(?:alone|only|solely))?\s+"
    rf"(?:{STATUS_LINKING_VERB.pattern}|"
    rf"{STATUS_AUXILIARY.pattern}|{PREMATURE_DATA_STATUS_WORD.pattern}))|"
    rf"\b(?:rather than|instead of)\s+(?:the\s+)?{DATA_STATUS_SUBJECT_PATTERN}"
)
EXPLICIT_GENERIC_SUBJECT = re.compile(
    rf"\b(?:{GENERIC_NOUN_SUBJECT_PATTERN}|{IDENTIFIER_SUBJECT_PATTERN})\b"
)
EXPLICIT_PRONOUN_SUBJECT = re.compile(rf"\b{PRONOUN_SUBJECT_PATTERN}\b")
HISTORICAL_DATA_SUBJECT_MODIFIER = re.compile(
    rf"\b(?:historical|superseded|former|previous)\s+"
    rf"{DATA_STATUS_SUBJECT_PATTERN}"
)
LEADING_HISTORICAL_DATA_FRAME = re.compile(
    rf"^\s*(?:(?:in the past|at one time|once)\s*,?\s+)"
    rf"(?:(?:a|an|the)\s+)?{DATA_STATUS_SUBJECT_PATTERN}"
)
PAST_STATUS_LINKING_VERBS = frozenset({"was", "were", "became", "remained"})
NON_REALIZED_STATUS_LINKING_VERBS = frozenset({"become", "becomes"})
REVIEW_WORD = re.compile(r"\b(?:review|reviewed)\b")
MERGE_WORD = re.compile(r"\b(?:merge|merged)\b")
CURRENT_DATA_CONTEXT = re.compile(r"\b(?:now|currently)\b")
NEGATION_MODIFIER_PATTERN = (
    r"(?!(?:approved|accepted|authoritative|selected|and|or|nor|but)\b)"
    r"[a-z0-9_-]+"
)
COORDINATED_STATUS_MODIFIER_PATTERN = r"(?:[a-z0-9_-]+ly|yet|still|already|ever)"


def status_is_locally_negated(group: str, status_word: re.Match[str]) -> bool:
    prefix = group[: status_word.start()]
    return bool(
        re.search(
            r"\b(?:not|never|no longer)"
            rf"(?:\s+{NEGATION_MODIFIER_PATTERN}){{0,3}}\s*$",
            prefix,
        )
    )


def status_is_negated(
    group: str,
    status_words: tuple[re.Match[str], ...],
    status_index: int,
) -> bool:
    status = status_words[status_index]
    if status_is_locally_negated(group, status):
        return True

    first = status_words[0]
    prefix = group[: first.start()]
    shared_negative = re.search(
        rf"\b(?:not|never|no longer)"
        rf"(?:\s+{NEGATION_MODIFIER_PATTERN}){{0,3}}\s*$",
        prefix,
    )
    shared_neither = re.search(
        rf"\bneither(?:\s+{NEGATION_MODIFIER_PATTERN}){{0,3}}\s*$",
        prefix,
    )
    if shared_negative is None and shared_neither is None:
        return False

    connectors = PREMATURE_DATA_STATUS_WORD.sub(
        "", group[first.start() : status_words[-1].end()]
    )
    if (
        re.fullmatch(
            rf"(?:\s|,|\b(?:and|or|nor)\b|"
            rf"\b{COORDINATED_STATUS_MODIFIER_PATTERN}\b)*",
            connectors,
        )
        is None
    ):
        return False
    if shared_neither is not None:
        return bool(re.search(r"\bnor\b", connectors))
    if status_index == 0:
        return False
    # A bare `not X and Y` normally negates only X. Commas or an alternative
    # coordinator make `not X, Y, or Z` an explicitly shared negative list.
    return "," in connectors or bool(re.search(r"\b(?:or|nor)\b", connectors))


def without_non_governing_subject_references(group: str) -> str:
    """Blank comparison/exclusion objects while preserving match offsets."""

    return NON_GOVERNING_SUBJECT_REFERENCE.sub(
        lambda match: " " * len(match.group()), group
    )


CLAUSE_TOKEN = re.compile(r"[a-z0-9_-]+(?:'[a-z]+)?")
MAX_STATUS_PROJECTION_CHARS = 1_000_000
MAX_STATUS_ASIDE_NESTING = 256
MAX_STATUS_COMMAS = 50_000


def clause_tokens(text: str) -> tuple[str, ...]:
    tokens: list[str] = []
    for match in CLAUSE_TOKEN.finditer(text):
        token = match.group()
        if token.endswith("'ve") and token[:-3] in FUTURE_OR_HYPOTHETICAL_MODALS:
            tokens.extend((token[:-3], "have"))
        elif token == "ve" and tokens and tokens[-1] in FUTURE_OR_HYPOTHETICAL_MODALS:
            tokens.append("have")
        else:
            tokens.append(token)
    return tuple(tokens)


def balanced_aside_projection(text: str) -> str:
    """Blank balanced delimiter spans with fixed input and nesting bounds."""

    if len(text) > MAX_STATUS_PROJECTION_CHARS:
        raise GuardError(
            f"status predicate prefix exceeds {MAX_STATUS_PROJECTION_CHARS} characters"
        )
    projected = list(text)
    parenthesis_stack: list[tuple[str, int]] = []
    closing_parenthesis = {")": "(", "]": "[", "}": "{"}
    for index, character in enumerate(text):
        if parenthesis_stack:
            projected[index] = " "
            if character in "([{":
                parenthesis_stack.append((character, index))
                if len(parenthesis_stack) > MAX_STATUS_ASIDE_NESTING:
                    raise GuardError("status predicate aside exceeds the nesting limit")
            elif character in closing_parenthesis:
                if closing_parenthesis[character] != parenthesis_stack[-1][0]:
                    raise GuardError("status predicate aside has mismatched delimiters")
                parenthesis_stack.pop()
            continue
        if character in "([{":
            projected[index] = " "
            parenthesis_stack.append((character, index))
    if parenthesis_stack:
        # A subject/predicate prefix can end inside an otherwise balanced span
        # whose closing delimiter follows the status word. Only fully balanced
        # spans are asides; restore a truncated span for conservative analysis.
        restore_start = parenthesis_stack[0][1]
        projected[restore_start:] = text[restore_start:]
    return "".join(projected)


def main_clause_projection(text: str) -> str:
    """Blank balanced asides so their predicate state cannot leak outward."""

    projected = list(balanced_aside_projection(text))
    comma_positions = [
        index for index, character in enumerate(projected) if character == ","
    ]
    if len(comma_positions) > MAX_STATUS_COMMAS:
        raise GuardError("status predicate prefix has too many comma boundaries")

    # Pair from the predicate end. This leaves an unmatched leading-clause
    # separator intact while isolating balanced comma-delimited asides nearest
    # the status predicate. The blanked spans are disjoint, keeping this linear.
    for comma_index in range(len(comma_positions) - 1, 0, -2):
        start = comma_positions[comma_index - 1]
        end = comma_positions[comma_index]
        projected[start : end + 1] = " " * (end - start + 1)
    return "".join(projected)


def has_modal_perfect_aspect(predicate_prefix: str) -> bool:
    """Recognize modal + have/'ve + modifiers + been/become clause tokens."""

    modal_seen = False
    have_seen = False
    for token in clause_tokens(predicate_prefix):
        if token in FUTURE_OR_HYPOTHETICAL_MODALS:
            modal_seen = True
            have_seen = False
        elif modal_seen and token == "have":
            have_seen = True
        elif have_seen and token in {"been", "become"}:
            return True
    return False


def status_predicate_contexts(
    group: str, status_words: tuple[re.Match[str], ...]
) -> tuple[StatusPredicateContext, ...]:
    """Bind tense, modality, and current-time markers to each status predicate."""

    contexts: list[StatusPredicateContext] = []
    linking_verb: str | None = None
    modal: str | None = None
    past_auxiliary = False
    perfect_aspect = False
    cursor = 0
    for index, status_word in enumerate(status_words):
        predicate_prefix = group[cursor : status_word.start()]
        predicate_projection = main_clause_projection(predicate_prefix)
        linking_verbs = tuple(STATUS_LINKING_VERB.finditer(predicate_projection))
        modals = tuple(FUTURE_OR_HYPOTHETICAL_MODAL.finditer(predicate_projection))
        past_auxiliaries = tuple(PAST_TENSE_AUXILIARY.finditer(predicate_projection))
        has_perfect_aspect = has_modal_perfect_aspect(predicate_projection)
        if linking_verbs:
            linking_verb = linking_verbs[-1].group()
            # A newly stated finite/linking predicate supersedes modality from
            # an earlier coordinated predicate unless it restates a modal.
            if not modals:
                modal = None
            if not past_auxiliaries:
                past_auxiliary = False
            if not has_perfect_aspect:
                perfect_aspect = False
        if modals:
            modal = modals[-1].group()
            past_auxiliary = False
            if not has_perfect_aspect:
                perfect_aspect = False
        if past_auxiliaries:
            past_auxiliary = True
        if has_perfect_aspect:
            perfect_aspect = True

        suffix_end = (
            status_words[index + 1].start()
            if index + 1 < len(status_words)
            else len(group)
        )
        predicate_window = predicate_prefix + group[status_word.end() : suffix_end]
        contexts.append(
            StatusPredicateContext(
                linking_verb=linking_verb,
                modal=modal,
                past_auxiliary=past_auxiliary,
                perfect_aspect=perfect_aspect,
                current=CURRENT_DATA_CONTEXT.search(predicate_window) is not None,
            )
        )
        cursor = status_word.end()
    return tuple(contexts)


def status_has_historical_context(
    group: str,
    status_words: tuple[re.Match[str], ...],
    contexts: tuple[StatusPredicateContext, ...],
    status_index: int,
) -> bool:
    context = contexts[status_index]
    if context.current:
        return False
    explicitly_past = (
        context.past_auxiliary or context.linking_verb in PAST_STATUS_LINKING_VERBS
    )
    if not explicitly_past:
        return False

    temporal_group = without_non_governing_subject_references(group)
    status_word = status_words[status_index]
    previous_end = status_words[status_index - 1].end() if status_index else 0
    next_start = (
        status_words[status_index + 1].start()
        if status_index + 1 < len(status_words)
        else len(group)
    )
    predicate_prefix = temporal_group[previous_end : status_word.start()]
    predicate_suffix = temporal_group[status_word.end() : next_start]
    shared_prefix = temporal_group[: status_words[0].start()]
    shared_postfix = temporal_group[status_words[-1].end() :]

    leading_frame = re.match(
        r"\s*(?:historically|previously|formerly)\b", shared_prefix
    ) or LEADING_HISTORICAL_DATA_FRAME.match(temporal_group)
    predicate_prefix_frame = re.search(
        r"\b(?:was|were|became|remained)\s+"
        r"(?:historically|previously|formerly|once)\s*$",
        predicate_prefix,
    )
    predicate_suffix_frame = re.match(
        r"\s*(?:historically|previously|formerly)\b", predicate_suffix
    )
    shared_postfix_frame = re.match(
        r"\s*(?:historically|previously|formerly)\b", shared_postfix
    )
    if any(
        frame is not None
        for frame in (
            leading_frame,
            predicate_prefix_frame,
            predicate_suffix_frame,
            shared_postfix_frame,
        )
    ):
        return True

    subject_region = subject_region_for_status_group(temporal_group, status_words)
    return HISTORICAL_DATA_SUBJECT_MODIFIER.search(subject_region) is not None


def contains_review_and_merge(text: str) -> bool:
    return REVIEW_WORD.search(text) is not None and MERGE_WORD.search(text) is not None


def status_has_future_review_gate(
    group: str,
    status_words: tuple[re.Match[str], ...],
    contexts: tuple[StatusPredicateContext, ...],
    status_index: int,
) -> bool:
    context = contexts[status_index]
    if context.current:
        return False
    before = group[: status_words[0].start()]
    after = group[status_words[-1].end() :]

    before_gate = re.search(r"\bonly (?:when|after)\b", before)
    before_is_gate = before_gate is not None and contains_review_and_merge(
        before[before_gate.start() :]
    )
    after_gate = re.search(r"\bonly (?:when|after)\b", after)
    after_is_gate = after_gate is not None and contains_review_and_merge(
        after[after_gate.start() :]
    )
    if not before_is_gate and not after_is_gate:
        return False
    return not context.perfect_aspect and (
        context.modal is not None
        or (
            not context.past_auxiliary
            and context.linking_verb in NON_REALIZED_STATUS_LINKING_VERBS
        )
    )


def split_conditional_status_clauses(clause: str) -> tuple[str, ...]:
    """Split only coordinators that start another complete subject/predicate."""

    groups: list[str] = []
    start = 0
    for boundary in CONDITIONAL_STATUS_CLAUSE_BOUNDARY.finditer(clause):
        left = clause[start : boundary.start()]
        right = clause[boundary.end() :]
        if STATUS_PREDICATE.search(left) is None:
            continue
        if COMPLETE_CLAUSE_START.match(right) is None:
            continue
        groups.append(left)
        start = boundary.end()
    groups.append(clause[start:])
    return tuple(group for group in groups if group.strip())


def split_data_status_clauses(sentence: str) -> tuple[str, ...]:
    return tuple(
        group
        for strong_clause in STRONG_STATUS_CLAUSE_BOUNDARY.split(sentence)
        if strong_clause.strip()
        for group in split_conditional_status_clauses(strong_clause)
    )


def subject_region_for_status_group(
    group: str, status_words: tuple[re.Match[str], ...]
) -> str:
    """Return the grammatical subject region governing a coordinated status list."""

    prefix = group[: status_words[0].start()]
    links = tuple(STATUS_LINKING_VERB.finditer(prefix))
    if not links:
        return prefix

    governing_link = links[-1]
    before_link = prefix[: governing_link.start()]
    auxiliaries = tuple(STATUS_AUXILIARY.finditer(before_link))
    if not auxiliaries:
        return before_link

    last_auxiliary = auxiliaries[-1]
    inverted_candidate = before_link[last_auxiliary.end() :]
    if (
        DATA_STATUS_SUBJECT.search(inverted_candidate) is not None
        or EXPLICIT_GENERIC_SUBJECT.search(inverted_candidate) is not None
        or EXPLICIT_PRONOUN_SUBJECT.search(inverted_candidate) is not None
    ):
        return inverted_candidate
    return before_link[: last_auxiliary.start()]


EXPLICIT_NAMED_SUBJECT_PATTERN = (
    rf"(?:{DATA_STATUS_SUBJECT_PATTERN}|{GENERIC_NOUN_SUBJECT_PATTERN}|"
    rf"{IDENTIFIER_SUBJECT_PATTERN})"
)
SUBORDINATE_CLAUSE_INTRODUCER_PATTERN = (
    r"(?:although|because|before|despite|if|notwithstanding|once|since|unless|"
    r"when|whereas|while|after|even\s+though|provided(?:\s+that)?)"
)
SUBJECT_MODIFIER_PATTERN = (
    r"(?:[a-z0-9_-]+ly|also|already|even|just|not|now|only|still|yet)"
)
MATRIX_CLAUSE_SUBJECT = re.compile(
    rf"^\s*(?:(?P<introducer>{SUBORDINATE_CLAUSE_INTRODUCER_PATTERN})\s+)?"
    r"(?:(?P<coordinator>and|but|or|so|yet)\s+)?"
    rf"(?:{SUBJECT_MODIFIER_PATTERN}\s+){{0,4}}"
    rf"(?P<subject>{EXPLICIT_NAMED_SUBJECT_PATTERN})"
    rf"(?=\s+(?:{SUBJECT_MODIFIER_PATTERN}\s+){{0,6}}"
    r"(?P<predicate>[a-z][a-z0-9_-]*(?:'[a-z]+)?)\b)"
)
SUBORDINATE_CLAUSE_INTRODUCER = re.compile(
    rf"\b{SUBORDINATE_CLAUSE_INTRODUCER_PATTERN}\b"
)
TOPICALIZED_NAMED_SUBJECT = re.compile(
    rf"^\s*as\s+for\s+(?P<subject>{EXPLICIT_NAMED_SUBJECT_PATTERN})"
    r"(?:\s+[a-z0-9_-]+){0,4}\s*$"
)
TRAILING_NAMED_SUBJECT = re.compile(
    rf"(?P<subject>{EXPLICIT_NAMED_SUBJECT_PATTERN})"
    rf"(?:\s+{SUBJECT_MODIFIER_PATTERN}){{0,4}}\s*$"
)
RELATIVE_COMMA_CLAUSE_START = re.compile(r"^\s*(?:that|which|who|whom|whose)\b")
CLAUSE_WORD = re.compile(r"[a-z][a-z0-9_-]*(?:'[a-z]+)?")
FINITE_AUXILIARY_WORDS = frozenset(
    {
        "am",
        "are",
        "be",
        "became",
        "become",
        "becomes",
        "been",
        "can",
        "could",
        "did",
        "do",
        "does",
        "had",
        "has",
        "have",
        "is",
        "may",
        "might",
        "must",
        "remain",
        "remained",
        "remains",
        "shall",
        "should",
        "was",
        "were",
        "will",
        "would",
    }
)


NON_SUBJECT_REFERENCE_WORDS = frozenset(
    {
        "about",
        "against",
        "among",
        "around",
        "between",
        "for",
        "from",
        "of",
        "over",
        "regarding",
        "than",
        "to",
        "under",
        "versus",
        "with",
        "without",
    }
)


def has_non_subject_reference_prefix(text: str, subject_start: int) -> bool:
    """Inspect only the immediately preceding word, without rescanning prefixes."""

    cursor = subject_start
    while cursor and text[cursor - 1].isspace():
        cursor -= 1
    end = cursor
    while cursor and (text[cursor - 1].isalnum() or text[cursor - 1] in "_-"):
        cursor -= 1
    return text[cursor:end] in NON_SUBJECT_REFERENCE_WORDS


def named_subject_has_data_scope(subject: str) -> bool:
    """Distinguish a DATA subject from a generic subject referring to DATA."""

    return any(
        not has_non_subject_reference_prefix(subject, match.start())
        for match in DATA_STATUS_SUBJECT.finditer(subject)
    )


def comma_segment_spans(text: str):
    start = 0
    for index, character in enumerate(text):
        if character == ",":
            yield start, index
            start = index + 1
    yield start, len(text)


def blank_relative_comma_clauses(projected: list[str]) -> None:
    """Blank comma-bounded relative clauses, including both delimiters."""

    snapshot = "".join(projected)
    for start, end in comma_segment_spans(snapshot):
        if (
            start > 0
            and end < len(snapshot)
            and RELATIVE_COMMA_CLAUSE_START.match(snapshot[start:end]) is not None
        ):
            projected[start - 1 : end + 1] = " " * (end - start + 2)


def comma_segment_is_non_matrix_aside(
    segment: str,
    match: re.Match[str],
    *,
    topic: re.Match[str] | None,
) -> bool:
    """Classify bounded subordinate, postpositive, and absolute asides."""

    if topic is not None:
        return False
    if match.groupdict().get("introducer") is not None:
        return True

    words = tuple(word.group() for word in CLAUSE_WORD.finditer(segment))
    for index, word in enumerate(words):
        if word in {"despite", "notwithstanding"} or word.endswith("ing"):
            return not any(
                prior_word in FINITE_AUXILIARY_WORDS for prior_word in words[:index]
            )
    return False


def matrix_subject_projection(text: str) -> str:
    """Blank balanced asides and non-matrix introducer-led adjunct spans."""

    projected = list(balanced_aside_projection(text))
    comma_count = projected.count(",")
    if comma_count > MAX_STATUS_COMMAS:
        raise GuardError("status subject prefix has too many comma boundaries")
    blank_relative_comma_clauses(projected)

    matrix_seen = False
    for start, end in comma_segment_spans("".join(projected)):
        segment = "".join(projected[start:end])
        topic = TOPICALIZED_NAMED_SUBJECT.match(segment)
        match = topic or MATRIX_CLAUSE_SUBJECT.match(segment)
        if match is None:
            continue
        if matrix_seen and comma_segment_is_non_matrix_aside(
            segment, match, topic=topic
        ):
            projected[start:end] = " " * (end - start)
            continue
        matrix_seen = True
        adjunct = SUBORDINATE_CLAUSE_INTRODUCER.search(segment, match.end())
        if adjunct is not None:
            adjunct_start = start + adjunct.start()
            projected[adjunct_start:end] = " " * (end - adjunct_start)
    return "".join(projected)


def matrix_clause_subject_scope(
    text: str, *, include_trailing_subject: bool = False
) -> bool | None:
    """Resolve the matrix subject while excluding asides and subordinate adjuncts."""

    projected = matrix_subject_projection(text)

    matrix_scope: bool | None = None
    later_main_scope: bool | None = None
    for segment_start, segment_end in comma_segment_spans(projected):
        segment = projected[segment_start:segment_end]
        topic = TOPICALIZED_NAMED_SUBJECT.match(segment)
        match = topic or MATRIX_CLAUSE_SUBJECT.match(segment)
        if match is not None:
            scope = named_subject_has_data_scope(match.group("subject"))
            introduced = (
                topic is None and match.groupdict().get("introducer") is not None
            )
            if matrix_scope is None:
                matrix_scope = scope
            elif not introduced and not comma_segment_is_non_matrix_aside(
                segment, match, topic=topic
            ):
                # A later explicit main-clause subject after a comma governs
                # that clause; an introducer-led segment is an adjunct instead.
                later_main_scope = scope
    if later_main_scope is not None:
        return later_main_scope
    if matrix_scope is not None:
        return matrix_scope
    if include_trailing_subject:
        match = TRAILING_NAMED_SUBJECT.search(projected)
        if match is not None and not has_non_subject_reference_prefix(
            projected, match.start("subject")
        ):
            return named_subject_has_data_scope(match.group("subject"))
    return None


def anaphoric_pronoun_subject_scope(subject_region: str) -> bool | None | tuple[()]:
    """Resolve a main pronoun to a nearer explicit subject or inherited scope."""

    pronouns = tuple(EXPLICIT_PRONOUN_SUBJECT.finditer(subject_region))
    if not pronouns:
        return ()
    pronoun = pronouns[-1]
    before_pronoun = subject_region[: pronoun.start()]
    after_pronoun = subject_region[pronoun.end() :]

    # An explicit subject after the pronoun governs the status predicate. If
    # none follows, resolve the projected matrix/topic subject, allowing a
    # later non-adjunct main clause to override it. Only a subject-free prefix
    # inherits discourse scope.
    after_scope = matrix_clause_subject_scope(
        after_pronoun, include_trailing_subject=True
    )
    if after_scope is not None:
        return after_scope
    return matrix_clause_subject_scope(before_pronoun)


def sentence_has_anaphoric_status_subject(sentence: str) -> bool:
    for group in split_data_status_clauses(sentence):
        semantic_group = without_non_governing_subject_references(group)
        status_words = tuple(PREMATURE_DATA_STATUS_WORD.finditer(semantic_group))
        if not status_words:
            continue
        subject_region = subject_region_for_status_group(semantic_group, status_words)
        if anaphoric_pronoun_subject_scope(subject_region) != ():
            return True
    return False


def data_subject_scope(
    group: str,
    inherited_data_scope: bool,
) -> tuple[bool, bool]:
    """Return DATA scope and whether this claim states an explicit subject."""

    without_comparisons = without_non_governing_subject_references(group)
    status_words = tuple(PREMATURE_DATA_STATUS_WORD.finditer(without_comparisons))
    subject_region = (
        subject_region_for_status_group(without_comparisons, status_words)
        if status_words
        else without_comparisons
    )
    pronoun_subject_scope = anaphoric_pronoun_subject_scope(subject_region)
    if pronoun_subject_scope != ():
        return (
            inherited_data_scope
            if pronoun_subject_scope is None
            else pronoun_subject_scope,
            True,
        )
    if DATA_STATUS_SUBJECT.search(subject_region) is not None:
        return True, True
    if EXPLICIT_GENERIC_SUBJECT.search(subject_region) is not None:
        return False, True
    if EXPLICIT_PRONOUN_SUBJECT.search(subject_region) is not None:
        return inherited_data_scope, True
    if DATA_STATUS_SUBJECT.search(without_comparisons) is not None:
        # Conservatively retain an explicit DATA reference when inversion or a
        # new predicate shape leaves it outside the ordinary subject region.
        return True, True
    if (
        status_words
        and STATUS_LINKING_VERB.search(without_comparisons[: status_words[0].start()])
        is not None
        and re.search(r"[a-z0-9]", subject_region)
    ):
        # A linking predicate also makes an unadorned noun phrase explicit
        # (for example, `server-only transcripts are ...`). Determiners are
        # useful for clause splitting, but are not required for subjecthood.
        return False, True
    return inherited_data_scope, False


def data_status_claim_groups(
    sentence: str, inherited_data_scope: bool
) -> tuple[tuple[tuple[str, bool], ...], bool]:
    """Return grammatical claims and the final subject scope for discourse."""

    groups: list[tuple[str, bool]] = []
    current_scope = inherited_data_scope
    final_subject_is_explicit = False
    for group in split_data_status_clauses(sentence):
        current_scope, final_subject_is_explicit = data_subject_scope(
            group, current_scope
        )
        groups.append((group, current_scope))
    # Ellipsis is claim-local. Cross-sentence inheritance is retained only
    # when the immediately preceding sentence ends with an explicit subject
    # (including a pronoun that itself inherited the prior DATA referent).
    return tuple(groups), current_scope if final_subject_is_explicit else False


def enforce_pending_data_review_status(root: Path, status: str) -> None:
    if status != "proposed_independent_review_pending":
        return
    discourse_location: tuple[str, str] | None = None
    discourse_sentence_index = 0
    discourse_block_index = 0
    discourse_data_scope = False
    for record in all_corpus_sentences(root):
        location = (record.path, record.location)
        same_block_continuation = (
            location == discourse_location
            and record.sentence_index == discourse_sentence_index + 1
        )
        same_document = (
            discourse_location is not None and record.path == discourse_location[0]
        )
        adjacent_semantic_block = (
            same_document and record.semantic_block_index == discourse_block_index + 1
        )
        if not same_block_continuation and not (
            adjacent_semantic_block
            and not record.hard_boundary_before
            and sentence_has_anaphoric_status_subject(record.sentence)
        ):
            discourse_data_scope = False
        groups, discourse_data_scope = data_status_claim_groups(
            record.sentence, discourse_data_scope
        )
        discourse_location = location
        discourse_sentence_index = record.sentence_index
        discourse_block_index = record.semantic_block_index
        for group, has_data_subject_scope in groups:
            temporal_group = without_non_governing_subject_references(group)
            status_words = tuple(PREMATURE_DATA_STATUS_WORD.finditer(temporal_group))
            if not status_words or not has_data_subject_scope:
                continue
            contexts = status_predicate_contexts(temporal_group, status_words)
            for status_index, _ in enumerate(status_words):
                if status_is_negated(temporal_group, status_words, status_index):
                    continue
                if status_has_historical_context(
                    temporal_group,
                    status_words,
                    contexts,
                    status_index,
                ):
                    continue
                if status_has_future_review_gate(
                    temporal_group,
                    status_words,
                    contexts,
                    status_index,
                ):
                    continue
                raise ContradictionError(
                    "data-review-status-prose",
                    root / record.path,
                    f"{record.location} sentence {record.sentence_index}: "
                    f"{group.strip()}",
                )


class DuplicateJsonKey(ValueError):
    pass


def unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(key)
        result[key] = value
    return result


def canonical_json(payload: object) -> str:
    return json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )


def load_prose_inventory(root: Path) -> tuple[InventorySentence, ...]:
    path = root / PROSE_INVENTORY
    try:
        source = path.read_bytes().decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise GuardError(f"cannot read {path}: {exc}") from exc
    if not source.endswith("\n") or "\r" in source:
        raise GuardError(f"{path} must use LF records with exactly one final newline")
    lines = source[:-1].split("\n")

    inventory: list[InventorySentence] = []
    for line_number, line in enumerate(lines, 1):
        try:
            payload = json.loads(line, object_pairs_hook=unique_json_object)
        except (TypeError, json.JSONDecodeError, DuplicateJsonKey) as exc:
            raise GuardError(f"{path}:{line_number} is not valid JSON") from exc
        if line != canonical_json(payload):
            raise GuardError(f"{path}:{line_number} is not canonically serialized")
        required = {
            "path",
            "location",
            "sentence_index",
            "occurrence",
            "categories",
            "sentence",
        }
        if not isinstance(payload, dict) or set(payload) != required:
            raise GuardError(f"{path}:{line_number} has an invalid inventory schema")
        relative = payload["path"]
        categories = payload["categories"]
        if (
            not isinstance(relative, str)
            or not isinstance(payload["location"], str)
            or type(payload["sentence_index"]) is not int
            or payload["sentence_index"] < 1
            or type(payload["occurrence"]) is not int
            or payload["occurrence"] < 1
            or not isinstance(payload["sentence"], str)
            or not isinstance(categories, list)
            or not categories
            or not all(isinstance(category, str) for category in categories)
        ):
            raise GuardError(f"{path}:{line_number} has invalid inventory values")
        expected_categories = [prose_category(relative)]
        if categories != expected_categories:
            raise GuardError(
                f"{path}:{line_number} categories must equal {expected_categories}"
            )
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
    if identities != sorted(identities):
        raise GuardError(f"{path} records are not in canonical identity order")
    return tuple(inventory)


def write_prose_inventory(root: Path) -> None:
    path = root / PROSE_INVENTORY
    lines = []
    for record in sorted(all_corpus_sentences(root), key=lambda item: item.identity):
        payload = {
            "path": record.path,
            "location": record.location,
            "sentence_index": record.sentence_index,
            "occurrence": record.occurrence,
            "categories": [prose_category(record.path)],
            "sentence": record.sentence,
        }
        lines.append(canonical_json(payload))
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
    unexpected = [
        record for record in actual if record.identity not in expected_identities
    ]
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
    missing = [
        entry for entry in inventory if entry.record.identity not in actual_identities
    ]
    if missing:
        entry = missing[0]
        record = entry.record
        raise ContradictionError(
            entry.categories[0],
            root / record.path,
            f"missing or relocated {record.location} sentence {record.sentence_index} "
            f"occurrence {record.occurrence}: {record.sentence}",
        )


def unique_section(
    parsed: list[Section], level: int, title: str, path: Path
) -> Section:
    visible_title = visible_markdown_fragment(title)
    found = [
        section
        for section in parsed
        if section.level == level and section.title == visible_title
    ]
    if len(found) != 1:
        raise GuardError(
            f"{path} requires exactly one level-{level} section {title!r}; found {len(found)}"
        )
    return found[0]


def visible_markdown_fragment(fragment: str) -> str:
    return "\n".join(rendered_blocks(COMMONMARK.parse(fragment)))


def require(section: Section | str, path: Path, *fragments: str) -> None:
    body = normalized(section.body if isinstance(section, Section) else section)
    for fragment in fragments:
        if normalized(visible_markdown_fragment(fragment)) not in body:
            label = section.title if isinstance(section, Section) else "document"
            raise GuardError(
                f"{path} section {label!r} lost required decision: {fragment}"
            )


def declaration_map(section: Section, path: Path) -> dict[str, str]:
    declarations: dict[str, str] = {}
    row = re.compile(r"^([a-z0-9_]+)\s+\|\s+([A-Za-z0-9_,.-]+)$")
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
    _, parsed = sections(adr)
    for title in REQUIRED_H2:
        unique_section(parsed, 2, title, adr)

    first_h2 = min(section.start for section in parsed if section.level == 2)
    preamble = active_markdown_prefix(adr, first_h2)
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
        "p2_data_01_status": "proposed_independent_review_pending",
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
    enforce_pending_data_review_status(root, declarations["p2_data_01_status"])
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
        "at least 24 hours",
        "result-map expiry, daemon restart, or same-lineage restore",
        "### Ambiguous-effect reconciliation",
    )
    anti = unique_section(parsed, 3, "Durable anti-replay heads and admission", adr)
    if not (objects.start < anti.start < objects.end):
        raise GuardError(
            f"{adr}: anti-replay section is outside Object/conflict section"
        )
    ambiguous = unique_section(parsed, 3, "Ambiguous-effect reconciliation", adr)
    if not (objects.start < ambiguous.start < objects.end):
        raise GuardError(
            f"{adr}: reconciliation section is outside Object/conflict section"
        )
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

    limits = unique_section(
        parsed, 2, "Limits, availability, and denial of service", adr
    )
    require(
        limits,
        adr,
        "durable external-effect anti-replay heads",
        "cap+1 fails before effect",
        "never remove a current head, tombstone, referenced revision, unresolved reconciliation record",
        "Admission reserves all journal/head/disk capacity before",
    )

    migration = unique_section(
        parsed, 2, "Migration and cutover contract for P2-DATA-02", adr
    )
    require(
        migration,
        adr,
        "Every transition CASes the exact `(migration_epoch, state)` pair and increments `migration_epoch`",
        "The state label has one intentional pre-cutover backward edge, but the epoch is strictly monotonic",
        "`legacy` | `copying`",
        "`copying` | `legacy`",
        "`copying` | `endpoint_verified`",
        "`endpoint_verified` | `scrubbed`",
        "No other edge is valid.",
        "no dual-read or dual-write",
        "old binaries fail startup",
    )

    rotation = unique_section(
        parsed, 2, "Rotation, revocation, deletion, and purge", adr
    )
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
        "Every success increments `migration_epoch`; a stale epoch/source-state CAS fails",
    )

    dependency = unique_section(parsed, 2, "Dependency hand-off", adr)
    require(
        dependency,
        adr,
        "P2-DATA-02 is schedulable only after P2-DATA-01 and P2-HOST-02 are reviewed and merged",
        "P2-TERM-01 upload and P2-HOST-03A interactive-tool work have each passed independent review and merged",
        "TERM-01 satisfies that dependency at `5d99ebb4`; HOST-03A remains pending",
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
        "removed in P2-AGENT-02/P2-TERM-02, reviewed and merged at `5722288`",
        "removed in reviewed/merged P2-HOST-02 at `4e7c89b`",
        "current source has no server-visible agent-upload path",
        "P2-HOST-03A and P2-DATA-01 remain independent-review candidates, not accepted behavior",
    )
    phase2_path = root / "docs/TRUST_PHASE2.md"
    phase2_text, phase2_sections = sections(phase2_path)
    unique_section(
        phase2_sections,
        2,
        "Current source reality (reviewed master through `5d99ebb4`)",
        phase2_path,
    )
    require(
        phase2_text,
        phase2_path,
        "P2-HOST-02 is reviewed and merged at `4e7c89b`",
        "Current source therefore has no server-visible host filesystem path",
        "P2-HOST-03A has an E2E implementation candidate under independent review; it is not merged",
        "P2-TERM-01 is independently reviewed and merged at `5d99ebb4`",
        "P2-DATA-02 remains blocked until P2-DATA-01, P2-HOST-02, P2-TERM-01, and P2-HOST-03A have each passed independent review and merged",
        "name the exact reviewed TERM-01 upload and HOST-03A tool protocol/effect-boundary commits",
    )
    tasks = active_markdown(root / "docs/TRUST_PHASE2_TASKS.md")
    require(
        tasks,
        root / "docs/TRUST_PHASE2_TASKS.md",
        "P2-HOST-02 | DONE — REVIEWED, MERGED (`4e7c89b`)",
        "P2-HOST-03A | ACTIVE — IMPLEMENTED, REVIEW PENDING",
        "P2-TERM-01 | DONE — REVIEWED, MERGED (`5d99ebb4`)",
        "P2-DATA-01, P2-HOST-02, P2-TERM-01, P2-HOST-03A (all independently reviewed and merged)",
        "Evidence names the exact reviewed TERM-01/HOST-03A protocol commits and effect boundaries",
    )

    progress = active_markdown(root / "docs/TRUST_PHASE2_PROGRESS.md")
    require(
        progress,
        root / "docs/TRUST_PHASE2_PROGRESS.md",
        "Only after P2-DATA-01 and P2-HOST-03A have passed independent review and merged",
        "TERM-01 at `5d99ebb4` and the future accepted HOST-03A commit",
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
    matrix_scope_cases = (
        (
            True,
            "while p2-data-01, which p2-host-02 reviewed, remains pending, it",
        ),
        (
            True,
            "while p2-data-01, who p2-host-02 reviewed, remains pending, it",
        ),
        (
            True,
            "while p2-data-01, whom p2-host-02 reviewed, remains pending, it",
        ),
        (
            True,
            "while p2-data-01, whose review p2-host-02 completed, remains pending, it",
        ),
        (
            True,
            "while p2-data-01, that p2-host-02 reviewed, remains pending, it",
        ),
        (
            True,
            "although p2-data-01 remains pending, p2-host-02 having reviewed it, it",
        ),
        (
            True,
            "although p2-data-01 remains pending, despite p2-host-02 objecting, it",
        ),
        (
            False,
            "although p2-data-01 remains pending, and p2-host-02 says it",
        ),
        (
            True,
            "although p2-host-02 remains pending, and p2-data-01 says it",
        ),
    )
    for expected_scope, probe in matrix_scope_cases:
        if matrix_clause_subject_scope(probe) is not expected_scope:
            raise GuardError("matrix-subject structural classification regressed")
    projection_probe = (
        "may " + ", once reviewers have been consulted, " * 10_000 + "become "
    )
    projection_start = time.perf_counter()
    projected_probe = main_clause_projection(projection_probe)
    projection_elapsed = time.perf_counter() - projection_start
    if len(projected_probe) != len(projection_probe) or projection_elapsed > 5.0:
        raise GuardError(
            "main-clause projection violated its linear-runtime regression bound"
        )
    matrix_probe = (
        "although p2-data-01"
        + ", which p2-host-02 reviewed," * 5_000
        + " awaits review"
        + ", after p2-host-02 completed review" * 5_000
    )
    matrix_start = time.perf_counter()
    matrix_scope = matrix_clause_subject_scope(matrix_probe)
    matrix_elapsed = time.perf_counter() - matrix_start
    if matrix_scope is not True or matrix_elapsed > 5.0:
        raise GuardError(
            "matrix-subject projection violated its linear-runtime regression bound"
        )
    for oversized_probe, expected_detail in (
        (
            "x" * (MAX_STATUS_PROJECTION_CHARS + 1),
            "status predicate prefix exceeds",
        ),
        (
            "(" * (MAX_STATUS_ASIDE_NESTING + 1)
            + "x"
            + ")" * (MAX_STATUS_ASIDE_NESTING + 1),
            "nesting limit",
        ),
    ):
        try:
            main_clause_projection(oversized_probe)
        except GuardError as exc:
            if expected_detail not in str(exc):
                raise
        else:
            raise GuardError("main-clause projection resource cap did not fail closed")
    try:
        visible_inline_tokens([Token("future_inline", "", 0)])
    except GuardError as exc:
        if "unsupported CommonMark inline token type" not in str(exc):
            raise
    else:
        raise GuardError("unknown CommonMark inline token did not fail closed")

    future_block = [Token("future_block", "", 0)]
    try:
        rendered_blocks(future_block)
    except GuardError as exc:
        if "unsupported CommonMark block token type" not in str(exc):
            raise
    else:
        raise GuardError("rendered_blocks did not reject an unknown block token")

    original_parse = COMMONMARK.parse
    COMMONMARK.parse = lambda _: future_block
    try:
        try:
            corpus_sentences(source, "docs/DURABLE_SENSITIVE_DATA.md")
        except GuardError as exc:
            if "unsupported CommonMark block token type" not in str(exc):
                raise
        else:
            raise GuardError("corpus_sentences did not reject an unknown block token")
    finally:
        COMMONMARK.parse = original_parse

    fence_cases = (
        (
            "closed blockquote fence",
            "> ```text\n> Phase 2 is finished.\n> ```\n",
            True,
        ),
        (
            "unclosed blockquote fence",
            "> ```text\n> Phase 2 is finished.\n",
            False,
        ),
        (
            "closed ordered-list fence",
            "1. item\n\n    ```text\n    Phase 2 is finished.\n    ```\n",
            True,
        ),
        (
            "unclosed ordered-list fence",
            "1. item\n\n    ```text\n    Phase 2 is finished.\n",
            False,
        ),
    )
    with tempfile.TemporaryDirectory(prefix="spawn-data-fence-") as temp:
        for index, (name, fixture_source, should_pass) in enumerate(fence_cases):
            path = Path(temp) / f"{index}.md"
            path.write_text(fixture_source, encoding="utf-8")
            try:
                markdown_tokens(path)
            except GuardError as exc:
                if should_pass or "unclosed CommonMark fence" not in str(exc):
                    raise GuardError(f"fence self-test {name!r} failed: {exc}") from exc
            else:
                if not should_pass:
                    raise GuardError(
                        f"fence self-test {name!r} accepted an unclosed fence"
                    )
    mutations: list[tuple[str, Callable[[Path], None], str | None]] = []
    positive_mutations: list[tuple[str, Callable[[Path], None]]] = []

    def add_comment_and_fence_decoys(path: Path, safe: str) -> None:
        text = path.read_text(encoding="utf-8")
        decoys = f"<!-- {safe} -->\n\n```text\n{safe}\n```\n\n"
        path.write_text(decoys + text, encoding="utf-8")

    def append_active_claim(path: Path, claim: str, safe_decoy: str) -> None:
        add_comment_and_fence_decoys(path, safe_decoy)
        path.write_text(
            path.read_text(encoding="utf-8") + f"\n\n{claim}\n", encoding="utf-8"
        )

    def claim_fixture(
        relative: str, claim: str, safe_decoy: str
    ) -> Callable[[Path], None]:
        def mutate(root: Path) -> None:
            append_active_claim(root / relative, claim, safe_decoy)

        return mutate

    def status_claim_fixture(relative: str, claim: str) -> Callable[[Path], None]:
        def mutate(root: Path) -> None:
            path = root / relative
            path.write_text(
                path.read_text(encoding="utf-8") + f"\n\n{claim}\n",
                encoding="utf-8",
            )
            write_prose_inventory(root)

        return mutate

    def status_markup_fixture(relative: str, markup: str) -> Callable[[Path], None]:
        def mutate(root: Path) -> None:
            path = root / relative
            path.write_text(
                path.read_text(encoding="utf-8") + f"\n\n{markup}\n",
                encoding="utf-8",
            )
            write_prose_inventory(root)

        return mutate

    def explicit_historical_and_review_status(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        path.write_text(
            path.read_text(encoding="utf-8")
            + "\n\nHistorical note: a superseded P2-DATA-01 experiment was approved "
            "before this review-pending ADR and is not current authority.\n\n"
            "P2-DATA-01 becomes accepted only after independent review and merge.\n",
            encoding="utf-8",
        )
        write_prose_inventory(root)

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
        path.write_text(
            text + "\n\nThe server is the canonical store.\n", encoding="utf-8"
        )

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
            "## Rejected alternatives",
            "## Decision\n\ndecoy\n\n## Rejected alternatives",
            1,
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
        path.write_text(
            path.read_text(encoding="utf-8") + "\n<!-- broken", encoding="utf-8"
        )

    def unclosed_commonmark_fence(root: Path) -> None:
        path = root / "docs/DURABLE_SENSITIVE_DATA.md"
        path.write_text(
            path.read_text(encoding="utf-8")
            + "\n\n```text\nPhase 2 is finished.\nnot-a-close```\n",
            encoding="utf-8",
        )

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
        lines[0] = canonical_json(payload)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def inventory_boolean_index(root: Path) -> None:
        path = root / PROSE_INVENTORY
        lines = path.read_text(encoding="utf-8").splitlines()
        payload = json.loads(lines[0])
        payload["sentence_index"] = True
        lines[0] = canonical_json(payload)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def inventory_duplicate_json_key(root: Path) -> None:
        path = root / PROSE_INVENTORY
        lines = path.read_text(encoding="utf-8").splitlines()
        lines[0] = '{"path":"duplicate",' + lines[0][1:]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def inventory_noncanonical_serialization(root: Path) -> None:
        path = root / PROSE_INVENTORY
        lines = path.read_text(encoding="utf-8").splitlines()
        lines[0] = json.dumps(json.loads(lines[0]), ensure_ascii=False, sort_keys=True)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def inventory_noncanonical_order(root: Path) -> None:
        path = root / PROSE_INVENTORY
        lines = path.read_text(encoding="utf-8").splitlines()
        lines[0], lines[1] = lines[1], lines[0]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def inventory_missing_final_newline(root: Path) -> None:
        path = root / PROSE_INVENTORY
        source = path.read_text(encoding="utf-8")
        path.write_text(source.removesuffix("\n"), encoding="utf-8")

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
    runtime_safe = "Status: proposed for independent review; runtime not implemented; Phase 2 incomplete."
    opaque_safe = (
        "Opaque client-encrypted server blobs are not selected and are forbidden "
        "as a Phase 2 fallback."
    )
    host02_safe = "P2-HOST-02 is reviewed and merged at 4e7c89b."
    ack_safe = (
        "User acknowledgement is never retry authority; dismissal preserves the lock."
    )
    rotation_safe = "The old epoch remains until both new-epoch anchor slots and all wrappers are verified."
    data02_safe = "P2-DATA-02 remains blocked until reviewed and merged P2-TERM-01 and P2-HOST-03A."

    mutations.extend(
        (
            (
                "active canonical-store contradiction with active safe declaration and HTML/fence decoys",
                canonical_html,
                "data-design-prose",
            ),
            (
                "premature approved durable-state status survives reinventory",
                status_claim_fixture(
                    "docs/DESIGN.md",
                    "The durable protected state is an approved target.",
                ),
                "data-review-status-prose",
            ),
            (
                "premature accepted DATA-01 status survives reinventory",
                status_claim_fixture(
                    "docs/INTERFACE_MATRIX.md",
                    "The P2-DATA-01 decision is accepted.",
                ),
                "data-review-status-prose",
            ),
            (
                "premature authoritative DATA-02 contract survives reinventory",
                status_claim_fixture(
                    "proto/README.md",
                    "The P2-DATA-02 store contract is authoritative.",
                ),
                "data-review-status-prose",
            ),
            (
                "premature selected DATA-01 status survives reinventory",
                status_claim_fixture(
                    "docs/DURABLE_SENSITIVE_DATA.md",
                    "P2-DATA-01 selected the per-host endpoint-local canonical store.",
                ),
                "data-review-status-prose",
            ),
            (
                "long DATA-01 status claim has no distance bypass",
                status_claim_fixture(
                    "docs/DESIGN.md",
                    "P2-DATA-01 remains the subject of detailed implementation "
                    "requirements and extensive verification evidence remains the "
                    "subject of detailed implementation requirements and extensive "
                    "verification evidence is approved.",
                ),
                "data-review-status-prose",
            ),
            (
                "endpoint-store approved variant survives reinventory",
                status_claim_fixture(
                    "docs/INTERFACE_MATRIX.md",
                    "The endpoint store is approved.",
                ),
                "data-review-status-prose",
            ),
            (
                "protected-data-store authoritative variant survives reinventory",
                status_claim_fixture(
                    "proto/README.md",
                    "The protected-data store is authoritative.",
                ),
                "data-review-status-prose",
            ),
            (
                "DATA-01 decision accepted variant survives reinventory",
                status_claim_fixture(
                    "docs/DURABLE_SENSITIVE_DATA.md",
                    "The DATA-01 decision is accepted.",
                ),
                "data-review-status-prose",
            ),
            (
                "historical safe clause cannot mask current selected claim",
                status_claim_fixture(
                    "docs/DESIGN.md",
                    "A historical P2-DATA-01 experiment was approved, but "
                    "P2-DATA-01 is selected now.",
                ),
                "data-review-status-prose",
            ),
            (
                "negated safe clause cannot mask authoritative contract claim",
                status_claim_fixture(
                    "docs/INTERFACE_MATRIX.md",
                    "P2-DATA-01 is not approved, but the P2-DATA-02 store contract "
                    "is authoritative now.",
                ),
                "data-review-status-prose",
            ),
            (
                "review-gated prototype clause cannot mask current selected claim",
                status_claim_fixture(
                    "proto/README.md",
                    "Only after review and merge may one prototype be accepted; "
                    "P2-DATA-01 is selected now.",
                ),
                "data-review-status-prose",
            ),
            (
                "same-clause review gate cannot mask later current selected claim",
                status_claim_fixture(
                    "docs/DURABLE_SENSITIVE_DATA.md",
                    "Only after review and merge may a prototype be accepted and "
                    "P2-DATA-01 is selected now.",
                ),
                "data-review-status-prose",
            ),
            (
                "same-clause historical marker cannot mask later current selected claim",
                status_claim_fixture(
                    "docs/DESIGN.md",
                    "Historically a prototype was accepted and P2-DATA-01 is "
                    "selected now.",
                ),
                "data-review-status-prose",
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
            (
                "duplicate prose inventory record is rejected",
                duplicate_inventory_record,
                None,
            ),
            (
                "prose inventory category drift is rejected",
                inventory_category_drift,
                None,
            ),
            ("boolean sentence index is rejected", inventory_boolean_index, None),
            (
                "duplicate JSON inventory key is rejected",
                inventory_duplicate_json_key,
                None,
            ),
            (
                "noncanonical JSON inventory serialization is rejected",
                inventory_noncanonical_serialization,
                None,
            ),
            (
                "noncanonical prose inventory order is rejected",
                inventory_noncanonical_order,
                None,
            ),
            (
                "missing canonical prose inventory final newline is rejected",
                inventory_missing_final_newline,
                None,
            ),
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
            ("unclosed CommonMark fence", unclosed_commonmark_fence, None),
            ("missing parser input", unreadable_input, None),
        )
    )

    status_reinventory_rejects = (
        ("private store selected", "The private store is selected."),
        ("durable-data store selected", "The durable-data store is selected."),
        ("endpoint-owned store selected", "The endpoint-owned store is selected."),
        ("generic canonical store selected", "The canonical store is selected."),
        (
            "inline raw HTML title keeps text boundaries",
            'a<span title="P2-DATA-01 is accepted">b</span>.',
        ),
        (
            "inline raw HTML ARIA label keeps text boundaries",
            'a<span aria-label="P2-DATA-01 is accepted">b</span>.',
        ),
        (
            "inline raw HTML multiple attributes stay mutually separated",
            'x<span title="P2-DATA-01 is accepted" '
            'aria-label="The private store is selected">y</span>z.',
        ),
        (
            "raw HTML block title remains semantic prose",
            '<div title="P2-DATA-01 is accepted">x</div>',
        ),
        (
            "native CommonMark title remains semantic prose",
            '[x](https://example.invalid "P2-DATA-01 is accepted")',
        ),
        (
            "DATA first in a shared coordinated predicate",
            "P2-DATA-01 and P2-HOST-02 are accepted.",
        ),
        (
            "DATA last in a shared coordinated predicate",
            "P2-HOST-02 and P2-DATA-01 are accepted.",
        ),
        (
            "DATA first in an or shared predicate",
            "P2-DATA-01 or P2-HOST-02 is accepted.",
        ),
        (
            "DATA last in an or shared predicate",
            "P2-HOST-02 or P2-DATA-01 is accepted.",
        ),
        (
            "DATA first in a generic-subject shared predicate",
            "P2-DATA-01 and the control protocol are accepted.",
        ),
        (
            "DATA last in a generic-subject shared predicate",
            "The control protocol and P2-DATA-01 are accepted.",
        ),
        (
            "DATA main subject with non-DATA unlike comparison",
            "P2-DATA-01, unlike P2-HOST-02, is accepted.",
        ),
        (
            "DATA first in an either-or shared predicate",
            "Either P2-DATA-01 or P2-HOST-02 is accepted.",
        ),
        (
            "DATA last in an either-or shared predicate",
            "Either P2-HOST-02 or P2-DATA-01 is accepted.",
        ),
        (
            "negative conjunction does not negate current selection",
            "P2-DATA-01 is not approved and selected now.",
        ),
        (
            "preposed future gate contradicted by current acceptance",
            "Only after independent review and merge is P2-DATA-01 accepted now.",
        ),
        (
            "postposed future gate contradicted by current acceptance",
            "P2-DATA-01 is currently accepted only after independent review and merge.",
        ),
        (
            "same-paragraph pronoun inherits DATA subject scope",
            "P2-DATA-01 remains review pending. It is accepted now.",
        ),
        (
            "although-clause DATA subject governs following pronoun",
            "Although P2-DATA-01 remains review pending, it is accepted now.",
        ),
        (
            "matrix DATA subject supports an adverb before its predicate",
            "Although P2-DATA-01 still remains review pending, it is accepted now.",
        ),
        (
            "matrix DATA subject supports an unlisted predicate verb",
            "Although P2-DATA-01 awaits review, it is accepted now.",
        ),
        (
            "matrix DATA subject supports adverb plus unlisted predicate",
            "Although P2-DATA-01 currently awaits review, it is accepted now.",
        ),
        (
            "while-clause DATA subject governs following pronoun",
            "While P2-DATA-01 remains review pending, it is accepted now.",
        ),
        (
            "whereas-clause DATA subject governs following pronoun",
            "Whereas P2-DATA-01 remains review pending, it is accepted now.",
        ),
        (
            "despite-clause DATA subject governs following pronoun",
            "Despite P2-DATA-01 remaining review pending, it is accepted now.",
        ),
        (
            "after-clause DATA subject governs following pronoun",
            "After P2-DATA-01 completed review, it is accepted now.",
        ),
        (
            "as-for DATA topic governs following pronoun",
            "As for P2-DATA-01, it is accepted now.",
        ),
        (
            "as-for DATA topic permits a bounded topic modifier",
            "As for P2-DATA-01 specifically, it is accepted now.",
        ),
        (
            "post-pronoun DATA subject overrides preceding non-DATA subject",
            "Although P2-HOST-02 remains review pending, it follows that "
            "P2-DATA-01 is accepted now.",
        ),
        (
            "matrix DATA subject governs over embedded non-DATA adjunct subject",
            "While P2-DATA-01 remains pending after P2-HOST-02 completed review, "
            "it is accepted now.",
        ),
        (
            "matrix DATA subject governs over parenthetical non-DATA subject",
            "Although P2-DATA-01 remains review pending "
            "(the control protocol remains unchanged), it is accepted now.",
        ),
        (
            "matrix DATA subject governs over nested parenthetical subjects",
            "Although P2-DATA-01 remains review pending "
            "(the control protocol remains unchanged "
            "[P2-HOST-02 still awaits review]), it is accepted now.",
        ),
        (
            "matrix DATA subject governs over a comma-bounded relative clause",
            "While P2-DATA-01, which P2-HOST-02 reviewed, remains review "
            "pending, it is accepted now.",
        ),
        (
            "matrix DATA subject governs over a nested relative-clause aside",
            "While P2-DATA-01, which P2-HOST-02 (the control protocol remaining "
            "unchanged) reviewed, remains review pending, it is accepted now.",
        ),
        (
            "matrix DATA subject governs over a postpositive notwithstanding aside",
            "Although P2-DATA-01 remains review pending, P2-HOST-02 "
            "notwithstanding, it is accepted now.",
        ),
        (
            "matrix DATA subject governs over an absolute-participial aside",
            "Although P2-DATA-01 remains review pending, the control protocol "
            "remaining unchanged, it is accepted now.",
        ),
        (
            "later DATA main-clause subject overrides leading HOST adjunct",
            "Although P2-HOST-02 remains review pending, P2-DATA-01 says it is "
            "accepted now.",
        ),
        (
            "incidental former alternative is not historical framing",
            "P2-DATA-01 is selected over the former alternative.",
        ),
        (
            "incidental previous review is not historical framing",
            "P2-DATA-01 is accepted after the previous review.",
        ),
        (
            "incidental previous adverb in review object is not historical framing",
            "P2-DATA-01 was accepted after a previously completed review.",
        ),
        (
            "outer former subject does not historically frame DATA predicate",
            "The former alternative says P2-DATA-01 was accepted.",
        ),
        (
            "historical past predicate cannot mask present predicate",
            "Historically, P2-DATA-01 was approved and is selected.",
        ),
        (
            "previously framed past predicate cannot mask present predicate",
            "Previously, P2-DATA-01 was approved and is authoritative.",
        ),
        (
            "completed past acceptance is not a future review gate",
            "P2-DATA-01 was accepted only after review and merge.",
        ),
        (
            "inverted completed past acceptance is not a future review gate",
            "Only after review and merge was P2-DATA-01 accepted.",
        ),
        (
            "completed past transition is not a future review gate",
            "P2-DATA-01 became accepted only after review and merge.",
        ),
        (
            "did-plus-transition is not a future review gate",
            "Only after review and merge did P2-DATA-01 become accepted.",
        ),
        (
            "past-perfect acceptance is not a future review gate",
            "P2-DATA-01 had been accepted only after review and merge.",
        ),
        (
            "must-perfect acceptance is completed rather than prospective",
            "P2-DATA-01 must have been accepted only after review and merge.",
        ),
        (
            "must-perfect survives paired-comma subordinate projection",
            "P2-DATA-01 must have, once reviewers have been consulted, been "
            "accepted only after review and merge.",
        ),
        (
            "must-perfect survives nested parenthetical projection",
            "P2-DATA-01 must have (once reviewers [who have been consulted] "
            "agree) been accepted only after review and merge.",
        ),
        (
            "must-perfect survives adjacent paired-comma asides",
            "P2-DATA-01 must, after review, have, once reviewers have been "
            "consulted, been accepted only after review and merge.",
        ),
        (
            "ASCII contracted must-perfect acceptance",
            "P2-DATA-01 must've been accepted only after review and merge.",
        ),
        (
            "Unicode contracted could-perfect acceptance",
            "P2-DATA-01 could’ve been accepted only after review and merge.",
        ),
        (
            "contracted may-perfect acceptance",
            "P2-DATA-01 may've been accepted only after review and merge.",
        ),
        (
            "Unicode contracted might-perfect acceptance",
            "P2-DATA-01 might’ve become accepted only after review and merge.",
        ),
        (
            "contracted should-perfect acceptance",
            "P2-DATA-01 should've been accepted only after review and merge.",
        ),
        (
            "Unicode contracted would-perfect acceptance",
            "P2-DATA-01 would’ve become accepted only after review and merge.",
        ),
        (
            "contracted will-perfect acceptance",
            "P2-DATA-01 will've been accepted only after review and merge.",
        ),
        (
            "Unicode contracted shall-perfect acceptance",
            "P2-DATA-01 shall’ve become accepted only after review and merge.",
        ),
        (
            "perfect aspect has no small modifier window",
            "P2-DATA-01 must have apparently already formally perhaps been "
            "accepted only after review and merge.",
        ),
        (
            "may-perfect acceptance is completed rather than prospective",
            "P2-DATA-01 may have been accepted only after review and merge.",
        ),
        (
            "might-perfect transition is completed rather than prospective",
            "P2-DATA-01 might have become accepted only after review and merge.",
        ),
        (
            "could-perfect acceptance is completed rather than prospective",
            "P2-DATA-01 could have been accepted only after review and merge.",
        ),
        (
            "should-perfect acceptance is completed rather than prospective",
            "P2-DATA-01 should have been accepted only after review and merge.",
        ),
        (
            "would-perfect transition is completed rather than prospective",
            "P2-DATA-01 would have become accepted only after review and merge.",
        ),
        (
            "will-perfect acceptance is completed aspect",
            "P2-DATA-01 will have been accepted only after review and merge.",
        ),
        (
            "shall-perfect transition is completed aspect",
            "P2-DATA-01 shall have become accepted only after review and merge.",
        ),
        (
            "future modal contradicted by current status",
            "P2-DATA-01 will be accepted now only after review and merge.",
        ),
        (
            "inverted future modal contradicted by current status",
            "Only after review and merge will P2-DATA-01 be accepted currently.",
        ),
        (
            "DATA main subject with parenthetical non-DATA comparison",
            "P2-DATA-01 (unlike P2-HOST-02) is accepted.",
        ),
        (
            "DATA main subject with excluded non-DATA object",
            "P2-DATA-01, not P2-HOST-02, is accepted.",
        ),
        (
            "leading non-DATA comparison leaves DATA as main subject",
            "Unlike P2-HOST-02, P2-DATA-01 is accepted.",
        ),
        (
            "DATA main subject precedes rather-than non-DATA object",
            "P2-DATA-01 rather than P2-HOST-02 is accepted.",
        ),
        (
            "dash comparison leaves DATA as main subject",
            "P2-DATA-01—unlike P2-HOST-02—is accepted.",
        ),
        (
            "between comparison leaves DATA as explicit main subject",
            "Between P2-HOST-02 and P2-DATA-01, only P2-DATA-01 is accepted.",
        ),
        (
            "among comparison leaves DATA as explicit main subject",
            "Among P2-HOST-02, P2-TERM-01, and P2-DATA-01, only "
            "P2-DATA-01 is accepted.",
        ),
        (
            "between comparison DATA main subject with alone modifier",
            "Between P2-HOST-02 and P2-DATA-01, P2-DATA-01 alone is accepted.",
        ),
        (
            "among comparison DATA main subject with solely modifier",
            "Among P2-HOST-02, P2-TERM-01, and P2-DATA-01, P2-DATA-01 "
            "solely is accepted.",
        ),
        (
            "past-review noun phrase is not explicit historical framing",
            "In the past review, P2-DATA-01 was accepted.",
        ),
        (
            "once-clause is not a predicate-local historical adverb",
            "P2-DATA-01 was selected once the previous review merged.",
        ),
        (
            "modified negative and-list does not negate current selection",
            "P2-DATA-01 is not yet approved and currently selected now.",
        ),
        (
            "elided DATA subject after negated adversative",
            "P2-DATA-01 is not approved, but selected now.",
        ),
        (
            "elided DATA subject after historical adversative",
            "Historically, P2-DATA-01 was approved, but selected now.",
        ),
        (
            "prototype review gate cannot govern later DATA subject",
            "Only after review and merge may a prototype be accepted before "
            "P2-DATA-01 is selected now.",
        ),
        (
            "prototype history cannot govern later DATA subject",
            "Historically a prototype was accepted before P2-DATA-01 is selected now.",
        ),
    )
    mutations.extend(
        (
            f"status claim-group reject: {name}",
            status_claim_fixture("docs/DESIGN.md", sentence),
            "data-review-status-prose",
        )
        for name, sentence in status_reinventory_rejects
    )
    status_block_reinventory_rejects = (
        (
            "pronoun inherits DATA across paragraphs",
            "P2-DATA-01 remains review pending.\n\nIt is accepted now.",
        ),
        (
            "pronoun inherits DATA across blockquote paragraphs",
            "> P2-DATA-01 remains review pending.\n>\n> It is accepted now.",
        ),
        (
            "pronoun inherits DATA across list items",
            "- P2-DATA-01 remains review pending.\n- It is accepted now.",
        ),
        (
            "pronoun inherits DATA from heading to paragraph",
            "## P2-DATA-01 remains review pending\n\nIt is accepted now.",
        ),
        (
            "pronoun inherits DATA across HTML paragraphs",
            "<p>P2-DATA-01 remains review pending.</p>\n\n<p>It is accepted now.</p>",
        ),
        (
            "however-led pronoun inherits DATA across paragraphs",
            "P2-DATA-01 remains review pending.\n\nHowever, it is accepted now.",
        ),
        (
            "nevertheless-led pronoun inherits DATA across paragraphs",
            "P2-DATA-01 remains review pending.\n\nNevertheless, it is accepted now.",
        ),
        (
            "coordinator-led pronoun inherits DATA across paragraphs",
            "P2-DATA-01 remains review pending.\n\nAnd it is accepted now.",
        ),
        (
            "consequent demonstrative inherits DATA across paragraphs",
            "P2-DATA-01 remains review pending.\n\nTherefore, this is selected now.",
        ),
        (
            "nested discourse connectives retain anaphoric DATA scope",
            "P2-DATA-01 remains review pending.\n\n"
            "However, therefore, it is accepted now.",
        ),
        (
            "multiword discourse phrase retains anaphoric DATA scope",
            "P2-DATA-01 remains review pending.\n\nAs a result, it is accepted now.",
        ),
        (
            "unlisted discourse phrase retains anaphoric DATA scope",
            "P2-DATA-01 remains review pending.\n\nEven so it is accepted now.",
        ),
        (
            "punctuated arbitrary phrase retains anaphoric DATA scope",
            "P2-DATA-01 remains review pending.\n\n"
            "For reasons recorded elsewhere—surprisingly—it is accepted now.",
        ),
        (
            "parenthetical discourse phrase retains demonstrative DATA scope",
            "P2-DATA-01 remains review pending.\n\n"
            "Regardless of the outcome (unexpectedly), this is selected now.",
        ),
    )
    mutations.extend(
        (
            f"status cross-block reject: {name}",
            status_markup_fixture("docs/DESIGN.md", markup),
            "data-review-status-prose",
        )
        for name, markup in status_block_reinventory_rejects
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
            "four-space-indented backticks do not fence following prose",
            adr_path,
            "---\n\n    ```\n\nPhase 2 is finished.",
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "generic angle-bracket prose remains visible",
            adr_path,
            "<Phase 2 is finished.>",
            runtime_safe,
            "data-design-prose",
            "<phase 2 is finished.>",
        ),
        (
            "image alt prose remains visible",
            adr_path,
            '<img alt="Phase 2 is finished." src="missing.png">',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "input value prose remains visible",
            adr_path,
            '<input value="Phase 2 is finished.">',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "HTML title prose remains visible",
            adr_path,
            '<span title="Phase 2 is finished."></span>',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "ARIA label prose remains visible",
            adr_path,
            '<div aria-label="Phase 2 is finished."></div>',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "ARIA description prose remains visible",
            adr_path,
            '<div aria-description="Phase 2 is finished."></div>',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "CommonMark image alt prose remains visible",
            adr_path,
            "![Phase 2 is finished.](missing.png)",
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "CommonMark image alt entity whitespace remains visible",
            adr_path,
            "![Phase&#32;2&nbsp;is finished.](missing.png)",
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "CommonMark image alt entity whitespace and escaped punctuation remain visible",
            adr_path,
            "![Phase&#32;2&nbsp;is finished\\.](missing.png)",
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "CommonMark top-level entity whitespace and escaped punctuation remain visible",
            adr_path,
            "Phase&#32;2&nbsp;is finished\\.",
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "inline CommonMark link title remains visible",
            adr_path,
            '[x](https://example.invalid "Phase 2 is finished.")',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "inline CommonMark image title remains visible",
            adr_path,
            '![alt](missing.png "Phase 2 is finished.")',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "reference CommonMark link title remains visible",
            adr_path,
            '[x][claim]\n\n[claim]: https://example.invalid "Phase 2 is finished."',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
        ),
        (
            "reference CommonMark image title remains visible",
            adr_path,
            '![alt][claim]\n\n[claim]: missing.png "Phase 2 is finished."',
            runtime_safe,
            "data-design-prose",
            "phase 2 is finished.",
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
            "explicit historical and review-gated DATA status remains allowed",
            explicit_historical_and_review_status,
        )
    )
    positive_mutations.append(
        (
            "equivalent visible Markdown and Unicode formatting remains accepted",
            equivalent_visible_formatting,
        )
    )
    status_reinventory_accepts = (
        (
            "shared compound negation",
            "P2-DATA-01 is not approved, accepted, or selected.",
        ),
        (
            "shared compound and-list negation",
            "P2-DATA-01 is not approved, accepted, and selected.",
        ),
        (
            "neither nor negation",
            "P2-DATA-01 is neither approved nor accepted.",
        ),
        (
            "historical status list",
            "Historically, P2-DATA-01 was approved and accepted.",
        ),
        (
            "review gate with reversed merge ordering",
            "Only after it is merged following independent review does "
            "P2-DATA-01 become accepted.",
        ),
        (
            "unrelated P2-HOST status",
            "P2-DATA-01 remains review pending and P2-HOST-02 is accepted.",
        ),
        (
            "unrelated host protocol status",
            "P2-DATA-01 remains review pending and the host protocol is accepted.",
        ),
        (
            "unrelated control protocol status",
            "P2-DATA-01 remains review pending and the control protocol is accepted.",
        ),
        (
            "unrelated parser status after semicolon",
            "P2-DATA-01 remains review pending; the Markdown parser is accepted.",
        ),
        (
            "unrelated control protocol status before DATA clause",
            "The control protocol is accepted and P2-DATA-01 remains review pending.",
        ),
        (
            "unrelated parser status before DATA clause",
            "The Markdown parser is accepted; P2-DATA-01 remains review pending.",
        ),
        (
            "although-clause non-DATA subject governs following pronoun",
            "Although P2-HOST-02 remains review pending, it is accepted.",
        ),
        (
            "matrix non-DATA subject supports an adverb before its predicate",
            "Although P2-HOST-02 still remains review pending, it is accepted.",
        ),
        (
            "matrix non-DATA subject supports an unlisted predicate verb",
            "Although P2-HOST-02 awaits review, it is accepted.",
        ),
        (
            "matrix non-DATA subject supports adverb plus unlisted predicate",
            "Although P2-HOST-02 currently awaits review, it is accepted.",
        ),
        (
            "while-clause non-DATA subject governs following pronoun",
            "While P2-HOST-02 remains review pending, it is accepted.",
        ),
        (
            "whereas-clause non-DATA subject governs following pronoun",
            "Whereas P2-HOST-02 remains review pending, it is accepted.",
        ),
        (
            "despite-clause non-DATA subject governs following pronoun",
            "Despite P2-HOST-02 remaining review pending, it is accepted.",
        ),
        (
            "after-clause non-DATA subject governs following pronoun",
            "After P2-HOST-02 completed review, it is accepted.",
        ),
        (
            "as-for non-DATA topic governs following pronoun",
            "As for P2-HOST-02, it is accepted.",
        ),
        (
            "as-for non-DATA topic permits a bounded topic modifier",
            "As for P2-HOST-02 specifically, it is accepted.",
        ),
        (
            "as-for non-DATA topic permits a multiword modifier",
            "As for P2-HOST-02 in particular, it is accepted.",
        ),
        (
            "post-pronoun non-DATA subject overrides preceding DATA subject",
            "Although P2-DATA-01 remains review pending, it follows that "
            "P2-HOST-02 is accepted.",
        ),
        (
            "matrix non-DATA subject governs over embedded DATA adjunct subject",
            "While P2-HOST-02 remains pending after P2-DATA-01 completed review, "
            "it is accepted.",
        ),
        (
            "matrix non-DATA subject governs over parenthetical DATA subject",
            "Although P2-HOST-02 remains review pending "
            "(P2-DATA-01 remains unchanged), it is accepted.",
        ),
        (
            "matrix non-DATA subject governs over nested parenthetical DATA subjects",
            "Although P2-HOST-02 remains review pending "
            "(P2-DATA-01 remains unchanged "
            "[the durable protected-data store still awaits review]), it is accepted.",
        ),
        (
            "matrix non-DATA subject governs over a comma-bounded relative clause",
            "While P2-HOST-02, which P2-DATA-01 reviewed, remains review pending, "
            "it is accepted.",
        ),
        (
            "matrix non-DATA subject governs over a nested relative-clause aside",
            "While P2-HOST-02, which P2-DATA-01 (the control protocol remaining "
            "unchanged) reviewed, remains review pending, it is accepted.",
        ),
        (
            "matrix non-DATA subject governs over a postpositive notwithstanding aside",
            "Although P2-HOST-02 remains review pending, P2-DATA-01 "
            "notwithstanding, it is accepted.",
        ),
        (
            "matrix non-DATA subject governs over an absolute-participial DATA aside",
            "Although P2-HOST-02 remains review pending, the durable protected-data "
            "store remaining unchanged, it is accepted.",
        ),
        (
            "later HOST main-clause subject overrides leading DATA adjunct",
            "Although P2-DATA-01 remains review pending, P2-HOST-02 says it is "
            "accepted.",
        ),
        (
            "historical marker after DATA status",
            "A P2-DATA-01 experiment was approved historically.",
        ),
        (
            "previously framed coordinated past statuses",
            "Previously, P2-DATA-01 was approved and accepted.",
        ),
        (
            "predicate-local previous adverb",
            "A P2-DATA-01 experiment was previously approved.",
        ),
        (
            "superseded DATA experiment subject",
            "A superseded P2-DATA-01 experiment was accepted.",
        ),
        (
            "historically framed past transition",
            "Historically, a P2-DATA-01 experiment became accepted.",
        ),
        (
            "explicit in-the-past frame",
            "In the past, P2-DATA-01 was accepted.",
        ),
        (
            "explicit in-the-past frame without comma",
            "In the past P2-DATA-01 was accepted.",
        ),
        (
            "predicate-local once frame",
            "P2-DATA-01 was once selected.",
        ),
        (
            "leading once frame with comma",
            "Once, P2-DATA-01 was selected.",
        ),
        (
            "leading once frame without comma",
            "Once P2-DATA-01 was selected.",
        ),
        (
            "explicit at-one-time frame",
            "At one time, P2-DATA-01 was authoritative.",
        ),
        (
            "predicate-local formerly frame",
            "P2-DATA-01 was formerly accepted.",
        ),
        (
            "future modal review gate",
            "P2-DATA-01 will become accepted only after review and merge.",
        ),
        (
            "hypothetical modal review gate with reversed evidence order",
            "P2-DATA-01 may be accepted only after merge and independent review.",
        ),
        (
            "subordinate perfect does not complete main may predicate",
            "P2-DATA-01 may, once reviewers have been consulted, become accepted "
            "only after review and merge.",
        ),
        (
            "parenthetical perfect does not complete main may predicate",
            "P2-DATA-01 may (once reviewers have been consulted) become accepted "
            "only after review and merge.",
        ),
        (
            "nested parenthetical perfect does not complete main may predicate",
            "P2-DATA-01 may (once reviewers [who have been consulted] agree) "
            "become accepted only after review and merge.",
        ),
        (
            "nested paired-comma subordinate perfect stays off main predicate",
            "P2-DATA-01 may, once reviewers have, after interviews, been "
            "consulted, become accepted only after review and merge.",
        ),
        (
            "leading comma boundary preserves subordinate projection",
            "Accordingly, P2-DATA-01 may, once reviewers have been consulted, "
            "become accepted only after review and merge.",
        ),
        (
            "must prospective review gate",
            "P2-DATA-01 must be accepted only after review and merge.",
        ),
        (
            "might prospective review gate",
            "P2-DATA-01 might become accepted only after review and merge.",
        ),
        (
            "could prospective review gate",
            "P2-DATA-01 could be accepted only after review and merge.",
        ),
        (
            "should prospective review gate",
            "P2-DATA-01 should become accepted only after review and merge.",
        ),
        (
            "would prospective review gate",
            "P2-DATA-01 would be accepted only after review and merge.",
        ),
        (
            "shall prospective review gate",
            "P2-DATA-01 shall become accepted only after review and merge.",
        ),
        (
            "shared negative list with yet modifier",
            "P2-DATA-01 is not yet approved or accepted.",
        ),
        (
            "shared negative list with formally modifier",
            "P2-DATA-01 was never formally approved or accepted.",
        ),
        (
            "neither-nor list with current modifier",
            "P2-DATA-01 is neither currently approved nor accepted.",
        ),
        (
            "coordinated negative list with second adverb",
            "P2-DATA-01 is not yet approved or formally accepted.",
        ),
        (
            "neither-nor list with modifiers on both statuses",
            "P2-DATA-01 is neither currently approved nor formally accepted.",
        ),
        (
            "non-DATA main subject with DATA unlike comparison",
            "P2-HOST-02, unlike P2-DATA-01, is accepted.",
        ),
        (
            "non-DATA main subject with parenthetical DATA comparison",
            "P2-HOST-02 (unlike P2-DATA-01) is accepted.",
        ),
        (
            "non-DATA main subject excludes DATA object",
            "The control protocol, not P2-DATA-01, is accepted.",
        ),
        (
            "non-DATA main subject parenthetically excludes DATA object",
            "The control protocol (not P2-DATA-01) is accepted.",
        ),
        (
            "leading DATA comparison leaves non-DATA as main subject",
            "Unlike P2-DATA-01, P2-HOST-02 is accepted.",
        ),
        (
            "em-dash DATA comparison leaves non-DATA main subject",
            "P2-HOST-02—unlike P2-DATA-01—is accepted.",
        ),
        (
            "en-dash DATA comparison leaves non-DATA main subject",
            "P2-HOST-02–unlike P2-DATA-01–is accepted.",
        ),
        (
            "spaced-dash DATA comparison leaves non-DATA main subject",
            "P2-HOST-02 - unlike P2-DATA-01 - is accepted.",
        ),
        (
            "between comparison leaves named non-DATA main subject",
            "Between P2-HOST-02 and P2-DATA-01, only P2-HOST-02 is accepted.",
        ),
        (
            "between comparison object order does not change main subject",
            "Between P2-DATA-01 and P2-HOST-02, only P2-HOST-02 is accepted.",
        ),
        (
            "among comparison leaves named non-DATA main subject",
            "Among P2-DATA-01, P2-TERM-01, and P2-HOST-02, only "
            "P2-HOST-02 is accepted.",
        ),
        (
            "between comparison supports post-subject alone exclusivity",
            "Between P2-DATA-01 and P2-HOST-02, P2-HOST-02 alone is accepted.",
        ),
        (
            "between comparison object order preserves post-subject exclusivity",
            "Between P2-HOST-02 and P2-DATA-01, P2-HOST-02 only is accepted.",
        ),
        (
            "among comparison supports post-subject solely exclusivity",
            "Among P2-DATA-01, P2-TERM-01, and P2-HOST-02, P2-HOST-02 "
            "solely is accepted.",
        ),
        (
            "between comparison supports predicate-local solely exclusivity",
            "Between P2-DATA-01 and P2-HOST-02, P2-HOST-02 is solely accepted.",
        ),
        (
            "non-DATA main subject uses instead-of DATA object",
            "The control protocol instead of P2-DATA-01 is accepted.",
        ),
        (
            "non-DATA main subject uses rather-than DATA object",
            "The control protocol rather than P2-DATA-01 is accepted.",
        ),
    )
    positive_mutations.extend(
        (
            f"status claim-group accept: {name}",
            status_claim_fixture("docs/DESIGN.md", sentence),
        )
        for name, sentence in status_reinventory_accepts
    )
    status_block_reinventory_accepts = (
        (
            "comma asides cannot retain inherited DATA scope over a HOST matrix",
            "P2-DATA-01 remains review pending.\n\n"
            "While P2-HOST-02, which P2-DATA-01 reviewed, remains review pending, "
            "it is accepted.\n\n"
            "P2-DATA-01 remains review pending.\n\n"
            "While P2-HOST-02, which P2-DATA-01 (the control protocol remaining "
            "unchanged) reviewed, remains review pending, it is accepted.\n\n"
            "P2-DATA-01 remains review pending.\n\n"
            "Although P2-HOST-02 remains review pending, P2-DATA-01 "
            "notwithstanding, it is accepted.\n\n"
            "P2-DATA-01 remains review pending.\n\n"
            "Although P2-HOST-02 remains review pending, the durable protected-data "
            "store remaining unchanged, it is accepted.",
        ),
        (
            "as-for non-DATA topic overrides inherited DATA scope",
            "P2-DATA-01 remains review pending.\n\nAs for P2-HOST-02, it is accepted.",
        ),
        (
            "post-pronoun non-DATA subject overrides inherited DATA scope",
            "P2-DATA-01 remains review pending.\n\n"
            "Although it remains review pending, P2-HOST-02 is accepted.",
        ),
        (
            "paragraph non-DATA reset before pronoun",
            "P2-DATA-01 remains review pending.\n\n"
            "The control protocol remains review pending.\n\nIt is accepted.",
        ),
        (
            "blockquote non-DATA reset before pronoun",
            "> P2-DATA-01 remains review pending.\n>\n"
            "> The control protocol remains review pending.\n>\n> It is accepted.",
        ),
        (
            "list-item non-DATA reset before pronoun",
            "- P2-DATA-01 remains review pending.\n"
            "- The control protocol remains review pending.\n- It is accepted.",
        ),
        (
            "heading non-DATA reset before pronoun",
            "P2-DATA-01 remains review pending.\n\n"
            "## The control protocol remains review pending\n\nIt is accepted.",
        ),
        (
            "HTML non-DATA reset before pronoun",
            "<p>P2-DATA-01 remains review pending.</p>\n\n"
            "<p>The control protocol remains review pending.</p>\n\n"
            "<p>It is accepted.</p>",
        ),
        (
            "thematic break is a hard discourse boundary",
            "P2-DATA-01 remains review pending.\n\n---\n\nIt is accepted.",
        ),
        (
            "fenced code is a hard discourse boundary",
            "P2-DATA-01 remains review pending.\n\n```text\n"
            "inactive boundary\n```\n\nIt is accepted.",
        ),
        (
            "thematic break resets connective-led anaphora",
            "P2-DATA-01 remains review pending.\n\n---\n\nHowever, it is accepted.",
        ),
        (
            "explicit non-DATA reset governs connective-led pronoun",
            "P2-DATA-01 remains review pending.\n\n"
            "The control protocol remains review pending.\n\n"
            "Nevertheless, it is accepted.",
        ),
        (
            "explicit non-DATA reset governs arbitrary-phrase pronoun",
            "P2-DATA-01 remains review pending.\n\n"
            "The control protocol remains review pending.\n\n"
            "As a result, it is accepted.",
        ),
        (
            "arbitrary discourse phrase can introduce non-DATA reset subject",
            "P2-DATA-01 remains review pending.\n\n"
            "As a result, the control protocol is accepted.",
        ),
        (
            "fence resets arbitrary-phrase anaphora",
            "P2-DATA-01 remains review pending.\n\n```text\n"
            "inactive boundary\n```\n\nAs a result, it is accepted.",
        ),
    )
    positive_mutations.extend(
        (
            f"status cross-block accept: {name}",
            status_markup_fixture("docs/DESIGN.md", markup),
        )
        for name, markup in status_block_reinventory_accepts
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
            raise GuardError(
                f"normalization self-test mutation unexpectedly passed: {name}"
            )

        positive_base = base / "positive"
        for index, (name, mutation) in enumerate(positive_mutations):
            fixture = positive_base / str(index)
            copy_fixture(source, fixture)
            mutation(fixture)
            try:
                validate(fixture)
            except GuardError as exc:
                raise GuardError(
                    f"positive self-test {name!r} unexpectedly failed: {exc}"
                ) from exc


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
        print(
            f"durable protected-data decision guard failed: {exc}",
            file=__import__("sys").stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
