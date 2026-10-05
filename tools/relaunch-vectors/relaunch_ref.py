"""A reference implementation of the relaunch line and move note rules.

Written apart from the clients' relaunch module (web/src/lib/agent-relaunch.ts,
mobile/src/data/selectors/agent-relaunch.ts) so that the expected values in
proto/agent-note-vectors.json are not the module's own output read back:
generate.py builds the vectors from these functions and both clients' tests
must reproduce them. proto/README.md, 'Relaunch lines and move notes', states
the rules. Standard library only.
"""

import re

POSIX_FAMILY = {"sh", "bash", "zsh", "dash", "mksh", "ash"}
SHELLS = {**{n: "posix" for n in POSIX_FAMILY}, "ksh": "ksh", "fish": "fish", "pwsh": "pwsh",
          "powershell": "pwsh", "cmd": "cmd", "nu": "nushell"}
POSITIONAL = {"posix", "fish", "pwsh"}


def shell_family(login_shell):
    if login_shell is None:
        return "unknown"
    name = re.split(r"[\\/]", login_shell.strip())[-1]
    name = name.lstrip("-").lower()
    if name.endswith(".exe"):
        name = name[:-4]
    return SHELLS.get(name, "unknown")


POSIX_WORD = re.compile(r"^[A-Za-z0-9_@%+=:,./-]+$")
FISH_WORD = re.compile(r"^[A-Za-z0-9_+=:,./-]+$")
PWSH_WORD = re.compile(r"^[A-Za-z_][A-Za-z0-9_./:-]*$")
PWSH_QUOTES = "'‘’‚‛"


def pwsh_literal(value):
    return "'" + "".join(c + c if c in PWSH_QUOTES else c for c in value) + "'"


def quote(value, family="posix"):
    if family == "fish":
        if FISH_WORD.fullmatch(value):
            return value
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if family == "pwsh":
        if PWSH_WORD.fullmatch(value):
            return value
        return pwsh_literal(value)
    if POSIX_WORD.fullmatch(value):
        return value
    return "'" + value.replace("'", "'\\''") + "'"


ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def line_family(family):
    return family if family in ("fish", "pwsh") else "posix"


# A UUID as both CLIs write one, 8-4-4-4-12 hex digits and hyphenated, read in
# either case. Spelled out rather than re.IGNORECASE so it is plainly ASCII.
CANONICAL_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def canonical_id(cid):
    """The id a line may name, lower-case, or None for anything else.

    One recorded in upper case is the same conversation and is written
    lower-case; a flag, a path, a braced or padded UUID, or anything that is
    not a string is no id at all.
    """
    return cid.lower() if isinstance(cid, str) and CANONICAL_ID.fullmatch(cid) else None


def env_prefix(env, family="posix"):
    out = []
    for key, value in env.items():
        if not ENV_KEY.fullmatch(key):
            continue
        if family == "pwsh":
            out.append(f"$env:{key}={pwsh_literal(value)}; ")
        else:
            out.append(f"{key}={quote(value, family)} ")
    return "".join(out)


def yolo_available(agent):
    return bool((agent.get("yolo_args") or "").strip()) or len(agent.get("yolo_env") or {}) > 0


def run_command(agent, family="posix", honour_yolo=True):
    on = honour_yolo and agent.get("yolo") is True and yolo_available(agent)
    env = dict(agent.get("env") or {})
    if on:
        env.update(agent.get("yolo_env") or {})
    args = (agent.get("yolo_args") or "").strip() if on else ""
    return env_prefix(env, family) + agent["command"] + (" " + args if args else "")


GRAMMARS = {
    "claude-code": {"launch": "--session-id", "resume": "--resume", "continue": "--continue",
                    "permission": "--permission-mode", "prompt": True},
    "codex": {"launch": None, "resume": "resume", "continue": "resume --last",
              "permission": None, "prompt": False},
}
MODES = {"acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"}


def grammar(kind):
    if kind is None:
        return None
    return GRAMMARS.get(kind.strip().lower())


def permission_mode(mode):
    if mode == "manual":
        return "default"
    return mode if mode in MODES else None


def relaunch_line(agent, conversation, shell=None, mode=None, prompt=None):
    family = shell or "posix"
    q = line_family(family)
    g = grammar(agent.get("kind"))
    if mode is not None:
        if not g or not g["permission"]:
            return None
        mode = permission_mode(mode)
        if mode is None:
            return None
    if prompt is not None:
        if not g or not g["prompt"] or family not in POSITIONAL:
            return None
    parts = [run_command(agent, q, honour_yolo=mode is None)]
    if "start" in conversation:
        cid = canonical_id(conversation["start"])
        if cid and g and g["launch"]:
            parts.append(f"{g['launch']} {quote(cid, q)}")
    else:
        cid = canonical_id(conversation["resume"])
        if not g:
            return None
        if cid and g["resume"]:
            parts.append(f"{g['resume']} {quote(cid, q)}")
        elif g["continue"]:
            parts.append(g["continue"])
        else:
            return None
    if mode is not None:
        parts.append(f"{g['permission']} {quote(mode, q)}")
    if prompt is not None:
        parts.append(quote(prompt, q))
    return " ".join(parts)


# ---- note facts ---------------------------------------------------------

SPACES = set(range(0x09, 0x0E)) | {0x20, 0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F,
                                    0x3000} | set(range(0x2000, 0x200B))


# Unicode 15's Default_Ignorable_Code_Point, from Perl's \p{DI}.
DEFAULT_IGNORABLE = [(0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x1160),
                     (0x17B4, 0x17B5), (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E),
                     (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
                     (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A),
                     (0xE0000, 0xE0FFF)]


def invisible(cp):
    return (
        cp <= 0x1F or 0x7F <= cp <= 0x9F
        or any(lo <= cp <= hi for lo, hi in DEFAULT_IGNORABLE)
        or 0x200B <= cp <= 0x200F
        or 0x2028 <= cp <= 0x202E
        or 0x2060 <= cp <= 0x206F
        or 0xD800 <= cp <= 0xDFFF
        or 0xE000 <= cp <= 0xF8FF
        or 0xFDD0 <= cp <= 0xFDEF
        or 0xFE00 <= cp <= 0xFE0F
        or 0xFFF9 <= cp <= 0xFFFB
        or (cp & 0xFFFE) == 0xFFFE
        or 0xE0000 <= cp <= 0xE0FFF
        or cp >= 0xF0000
    )


NAME_LIMIT = 40
PATH_LIMIT = 160
NAME_ASCII = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._()-")


def note_host_name(name, fallback):
    out = []
    for ch in name or "":
        cp = ord(ch)
        if cp in SPACES:
            out.append(" ")
        elif invisible(cp):
            continue
        elif cp < 0x80 and ch not in NAME_ASCII:
            continue
        else:
            out.append(ch)
    cleaned = re.sub(" +", " ", "".join(out)).strip(" ")
    if not cleaned:
        return fallback
    if len(cleaned) > NAME_LIMIT:
        return cleaned[: NAME_LIMIT - 1] + "…"
    return cleaned


def note_os(os):
    if os is None:
        return None
    return {"linux": "Linux", "darwin": "macOS", "macos": "macOS", "windows": "Windows"}.get(
        os.strip().lower())


def note_path(path):
    if path is None or path.strip() == "":
        return None
    if len(path) > PATH_LIMIT:
        return None
    for ch in path:
        if invisible(ord(ch)) or ch == '"':
            return None
    return path


def where(host, fallback):
    name = note_host_name(host.get("name"), fallback)
    os = note_os(host.get("os"))
    return (name, f"{name} ({os})" if os else name)


def compose_note(facts):
    a, a_full = where(facts["from"], "another host")
    _, b_full = where(facts["to"], "this host")
    cwd = note_path(facts.get("cwd"))
    mem = note_path(facts.get("memory_path"))
    state = facts.get("state")
    if state in ("running", "blocked"):
        text = f"[SPAWN D] This conversation just moved from {a_full} to {b_full}"
        text += f" and continues in {cwd}." if cwd else "."
        text += f" Files were not copied, so anything not pushed from {a} is missing here."
        text += f" Background tasks and {a}-only MCP tools did not come along."
        if mem:
            text += (f" The memory folder named in your instructions is on {a};"
                     f" save memories under {mem} instead.")
        if state == "running":
            text += (" You were in the middle of a task: check whether your last action took"
                     " effect, then carry on.")
        else:
            text += (" You were waiting for an answer to a prompt when it moved, and it was not"
                     " answered: ask again if you still need it.")
        return text
    text = f"[SPAWN D: moved from {a_full} to {b_full}"
    text += f", now in {cwd}." if cwd else "."
    text += f" Not carried: unpushed files, background tasks, {a}-only MCP tools."
    if mem:
        text += f" Save memories under {mem}."
    return text + "] "


def note_delivery(kind, family, state, os):
    if state not in ("running", "blocked"):
        return "typed_no_enter"
    g = grammar(kind)
    return ("positional" if g and g["prompt"] and family in POSITIONAL
            and note_os(os) in ("Linux", "macOS") else "typed")


LINE_BYTES = 900


def plan_relaunch(agent, conversation, mode=None, shell=None, note=None):
    if note and mode is None:
        return None
    family = shell_family(shell)
    text = compose_note(note) if note else None
    delivery = (note_delivery(agent.get("kind"), family, note.get("state"), note["to"].get("os"))
                if note else None)
    line = relaunch_line(agent, conversation, family, mode,
                         text if delivery == "positional" else None)
    if line is not None and delivery == "positional" and len(line.encode("utf-8", "surrogatepass")) > LINE_BYTES:
        delivery = "typed"
        line = relaunch_line(agent, conversation, family, mode, None)
    if line is None:
        return None
    return {"line": line, "note": {"text": text, "delivery": delivery} if text else None}
