"""Built-in presets — seeded idempotently on app startup and via Alembic."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Preset

# Sourced from proto/README.md "Built-in presets" table.
# spawn does not manage agent credentials; each agent CLI handles its own
# auth interactively on the host (e.g. `claude /login`). The optional
# `install` command is run by the daemon when default_argv[0] isn't on PATH.
BUILTIN_PRESETS: list[dict] = [
    {
        "name": "claude-code",
        "agent_kind": "claude-code",
        "default_argv": ["claude"],
        "env_template": {},
        "install": "npm install -g @anthropic-ai/claude-code",
    },
    {
        "name": "codex",
        "agent_kind": "codex",
        "default_argv": ["codex"],
        "env_template": {},
        "install": "npm install -g @openai/codex",
    },
    {
        "name": "opencode",
        "agent_kind": "opencode",
        "default_argv": ["opencode"],
        "env_template": {},
        "install": "npm install -g opencode-ai",
    },
    {
        "name": "aider-sonnet",
        "agent_kind": "aider",
        "default_argv": ["aider", "--model", "claude-sonnet-4-6"],
        "env_template": {},
        # pipx is the cleanest install path; fall back to a user pip if not.
        "install": "pipx install aider-chat || pip install --user aider-chat",
    },
    {
        "name": "shell",
        "agent_kind": "shell",
        "default_argv": ["bash", "-l"],
        "env_template": {},
        "install": None,
    },
]


async def seed_builtin_presets(session: AsyncSession) -> None:
    """Insert any missing built-in presets, and backfill `install` on existing
    rows that were seeded before the install column existed."""
    existing = (
        (await session.execute(select(Preset).where(Preset.owner_user_id.is_(None))))
        .scalars()
        .all()
    )
    by_name = {p.name: p for p in existing}
    changed = False
    for spec in BUILTIN_PRESETS:
        row = by_name.get(spec["name"])
        if row is None:
            session.add(
                Preset(
                    owner_user_id=None,
                    name=spec["name"],
                    agent_kind=spec["agent_kind"],
                    default_argv=list(spec["default_argv"]),
                    env_template=dict(spec["env_template"]),
                    install=spec.get("install"),
                )
            )
            changed = True
        else:
            if row.install is None and spec.get("install"):
                row.install = spec["install"]
                changed = True
    if changed:
        await session.commit()
