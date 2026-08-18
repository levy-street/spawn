"""Built-in agent definitions — seeded idempotently on app startup.

Agents are launchable CLI tool shortcuts, not processes: the shortcut bar
types `command` into a session's shell. spawn does not manage agent
credentials; each CLI handles its own auth interactively on the host (e.g.
`claude /login`). `install` is offered visibly as "install & run" when the
command's binary is missing — never executed silently.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Agent

CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"

BUILTIN_AGENTS: list[dict] = [
    {
        "name": "claude-code",
        "kind": "claude-code",
        "command": "claude",
        "env": {},
        "install": "npm install -g @anthropic-ai/claude-code",
    },
    {
        "name": "codex",
        "kind": "codex",
        "command": "codex",
        "env": {},
        "install": CODEX_INSTALL_COMMAND,
    },
    {
        "name": "opencode",
        "kind": "opencode",
        "command": "opencode",
        "env": {},
        "install": "npm install -g opencode-ai",
    },
    {
        "name": "aider-sonnet",
        "kind": "aider",
        "command": "aider --model claude-sonnet-4-6",
        "env": {},
        # pipx is the cleanest install path; fall back to a user pip if not.
        "install": "pipx install aider-chat || pip install --user aider-chat",
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
                )
            )
            changed = True
        else:
            for field in ("kind", "command", "install"):
                if getattr(row, field) != spec.get(field):
                    setattr(row, field, spec.get(field))
                    changed = True
    if changed:
        await session.commit()
