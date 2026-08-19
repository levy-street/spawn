"""Built-in presets — seeded idempotently on app startup and via Alembic."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Preset

CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"

# Sourced from proto/README.md "Built-in presets" table.
# spawn does not manage agent credentials; each agent CLI handles its own
# auth interactively on the host (e.g. `claude /login`). The optional
# `install` command is run by the daemon when default_argv[0] isn't on PATH.
#
# `yolo_argv` is the tool's own "stop asking me" flag, appended when an agent
# is created with the YOLO toggle on. `None` means the tool has no such flag
# -- not that it has an empty one -- and the create form hides the toggle
# entirely rather than offering a control that would do nothing.
BUILTIN_PRESETS: list[dict] = [
    {
        "name": "claude-code",
        "agent_kind": "claude-code",
        "default_argv": ["claude"],
        "env_template": {},
        "install": "npm install -g @anthropic-ai/claude-code",
        "yolo_argv": ["--dangerously-skip-permissions"],
    },
    {
        "name": "codex",
        "agent_kind": "codex",
        "default_argv": ["codex"],
        "env_template": {},
        "install": CODEX_INSTALL_COMMAND,
        "yolo_argv": ["--yolo"],
    },
    {
        "name": "opencode",
        "agent_kind": "opencode",
        "default_argv": ["opencode"],
        "env_template": {},
        "install": "npm install -g opencode-ai",
        # No CLI flag exists: opencode drives autonomy from `permission` in
        # opencode.json, which is host-side config spawn does not write.
        "yolo_argv": None,
    },
    {
        "name": "aider-sonnet",
        "agent_kind": "aider",
        "default_argv": ["aider", "--model", "claude-sonnet-4-6"],
        "env_template": {},
        # pipx is the cleanest install path; fall back to a user pip if not.
        "install": "pipx install aider-chat || pip install --user aider-chat",
        "yolo_argv": ["--yes-always"],
    },
    {
        # Nous Research's agent. Installs its own dependencies and puts a
        # `hermes` binary on PATH; plain `hermes` is the documented entry
        # point for an interactive session (`--tui` is the fuller terminal
        # UI, one word away if we prefer it).
        "name": "hermes",
        "agent_kind": "hermes",
        "default_argv": ["hermes"],
        "env_template": {},
        "install": "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
        "yolo_argv": ["--yolo"],
    },
    {
        # xAI's coding agent. The npm package is the vendor-preferred install
        # -- it avoids depending on x.ai, which is Cloudflare-walled in some
        # environments -- and it also gives latest-version detection for free
        # through the existing npm parser.
        "name": "grok",
        "agent_kind": "grok",
        "default_argv": ["grok"],
        "env_template": {},
        "install": "npm install -g @xai-official/grok",
        # No documented flag: Grok Build has no auto-approve switch today.
        "yolo_argv": None,
    },
    {
        "name": "shell",
        "agent_kind": "shell",
        "default_argv": ["bash", "-l"],
        "env_template": {},
        "install": None,
        # A shell has no permission model to skip; it was never gated.
        "yolo_argv": None,
    },
]

# Server-owned fields on a built-in. Built-ins are `owner_user_id IS NULL` and
# the preset routes refuse to edit or delete them, so reconciling all of these
# on startup cannot clobber anything a user wrote -- and without it, a
# correction after release would never reach an existing deployment.
RECONCILED_FIELDS = ("agent_kind", "default_argv", "env_template", "install", "yolo_argv")


def compose_argv(default_argv: list[str], yolo_argv: list[str] | None, *, yolo: bool) -> list[str]:
    """The command an agent actually runs.

    Appending rather than replacing is the whole point: the preset keeps its
    identity, so `preset_id` survives and with it the daemon's
    install-when-missing path -- which typing a full custom command loses.
    """

    argv = list(default_argv)
    if not yolo or not yolo_argv:
        return argv
    # Idempotent: a preset whose default_argv already carries the flag must
    # not end up passing it twice.
    return argv + [flag for flag in yolo_argv if flag not in argv]


def _copy(value: object) -> object:
    """Never hand a mutable module constant to the ORM."""

    if isinstance(value, list):
        return list(value)
    if isinstance(value, dict):
        return dict(value)
    return value


async def seed_builtin_presets(session: AsyncSession) -> None:
    """Insert missing built-ins and keep server-owned preset metadata current."""
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
                    yolo_argv=_copy(spec.get("yolo_argv")),
                )
            )
            changed = True
            continue
        for field in RECONCILED_FIELDS:
            wanted = _copy(spec.get(field))
            if getattr(row, field) != wanted:
                setattr(row, field, wanted)
                changed = True
    if changed:
        await session.commit()
