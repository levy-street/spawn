"""Built-in agent definitions — seeded idempotently on app startup.

Agents are launchable CLI tool shortcuts, not processes: the shortcut bar
types `command` into a session's shell. spawn does not manage agent
credentials; each CLI handles its own auth interactively on the host (e.g.
`claude /login`). `install` is offered visibly as "install & run" when the
command's binary is missing — never executed silently.

`yolo_args`/`yolo_env` spell out how each CLI is told to stop asking for
permission. They are inert until a user turns the toggle on in Settings →
Agents (`agent_preferences`), and they are server-owned for built-ins: a tool
that renames its flag is fixed here and re-synced on the next startup.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Agent

CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"

# opencode resolves every action to allow/ask/deny; allowing all of them is the
# closest it gets to the other CLIs' bypass flags. Compact JSON — this is typed
# into a shell as a quoted word, so every byte shows up on screen.
OPENCODE_ALLOW_ALL = '{"edit":"allow","bash":"allow","webfetch":"allow"}'

BUILTIN_AGENTS: list[dict] = [
    {
        "name": "claude-code",
        "kind": "claude-code",
        "command": "claude",
        "env": {},
        "install": "npm install -g @anthropic-ai/claude-code",
        "yolo_args": "--dangerously-skip-permissions",
        "yolo_env": {},
    },
    {
        "name": "codex",
        "kind": "codex",
        "command": "codex",
        "env": {},
        "install": CODEX_INSTALL_COMMAND,
        # The long form rather than the older `--yolo` alias: it says what it
        # does, and it is the spelling that survived the rename.
        "yolo_args": "--dangerously-bypass-approvals-and-sandbox",
        "yolo_env": {},
    },
    {
        "name": "opencode",
        "kind": "opencode",
        "command": "opencode",
        "env": {},
        "install": "npm install -g opencode-ai",
        # opencode has no bypass flag; permissions are configuration, and
        # OPENCODE_PERMISSION is the env-shaped override of that config.
        "yolo_args": None,
        "yolo_env": {"OPENCODE_PERMISSION": OPENCODE_ALLOW_ALL},
    },
    {
        "name": "aider-sonnet",
        "kind": "aider",
        "command": "aider --model claude-sonnet-4-6",
        "env": {},
        # pipx is the cleanest install path; fall back to a user pip if not.
        "install": "pipx install aider-chat || pip install --user aider-chat",
        "yolo_args": "--yes-always",
        "yolo_env": {},
    },
    {
        # Nous Research's agent. The vendor script installs its own Python and
        # Node runtimes and puts a `hermes` binary on PATH; plain `hermes` is
        # the documented entry point for an interactive session. Auth is its
        # own (`hermes setup`, or keys in `~/.hermes/.env` on the host).
        "name": "hermes",
        "kind": "hermes",
        "command": "hermes",
        "env": {},
        "install": "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
        "yolo_args": "--yolo",
        "yolo_env": {},
    },
]


async def seed_builtin_agents(session: AsyncSession) -> None:
    """Insert missing built-ins and keep server-owned metadata current."""
    existing = (
        (await session.execute(select(Agent).where(Agent.owner_user_id.is_(None))))
        .scalars()
        .all()
    )
    by_name = {agent.name: agent for agent in existing}
    changed = False
    for spec in BUILTIN_AGENTS:
        row = by_name.get(spec["name"])
        if row is None:
            session.add(
                Agent(
                    owner_user_id=None,
                    name=spec["name"],
                    kind=spec["kind"],
                    command=spec["command"],
                    env=dict(spec["env"]),
                    install=spec.get("install"),
                    yolo_args=spec.get("yolo_args"),
                    yolo_env=dict(spec.get("yolo_env") or {}),
                )
            )
            changed = True
        else:
            for field in ("kind", "command", "install", "yolo_args"):
                if getattr(row, field) != spec.get(field):
                    setattr(row, field, spec.get(field))
                    changed = True
            wanted_env = dict(spec.get("yolo_env") or {})
            if dict(row.yolo_env or {}) != wanted_env:
                row.yolo_env = wanted_env
                changed = True
    if changed:
        await session.commit()
