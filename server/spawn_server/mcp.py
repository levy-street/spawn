"""Authenticated MCP surface for controlling Spawn."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from pydantic import AnyHttpUrl

from . import agent_control, auth, schemas
from .config import get_settings
from .db import get_sessionmaker
from .models import User
from .routes import agents as agents_routes
from .routes import capabilities as capabilities_routes
from .routes import hosts as hosts_routes
from .routes import presets as presets_routes


class SpawnTokenVerifier(TokenVerifier):
    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            payload = auth.decode_token(token)
        except HTTPException:
            return None
        if payload.get("kind") != auth.KIND_ACCESS:
            return None
        scopes = str(payload.get("scope") or "spawn").split()
        if "spawn" not in scopes:
            return None
        sub = payload.get("sub", "")
        if not sub.startswith("user:"):
            return None
        user_id = sub.split(":", 1)[1]
        sm = get_sessionmaker()
        async with sm() as session:
            user = await session.get(User, user_id)
            if user is None:
                return None
        return AccessToken(token=token, client_id=user_id, scopes=scopes)


def _public_url(path: str) -> AnyHttpUrl:
    base = get_settings().public_url.rstrip("/")
    return AnyHttpUrl(f"{base}{path}")


spawn_mcp = FastMCP(
    "spawn",
    instructions=(
        "Control Spawn hosts and terminal agents. Use these tools to list hosts, "
        "create or manage agents, send terminal input, capture snapshots, upload "
        "files, inspect host directories, manage agent CLI installs, and grant "
        "agents access to managed MCP servers and skills."
    ),
    json_response=True,
    stateless_http=True,
    streamable_http_path="/",
    token_verifier=SpawnTokenVerifier(),
    auth=AuthSettings(
        issuer_url=_public_url(""),
        resource_server_url=_public_url("/mcp"),
        required_scopes=["spawn"],
    ),
)


async def _mcp_user(session) -> User:
    access = get_access_token()
    if access is None:
        raise RuntimeError("not authenticated")
    user = await session.get(User, access.client_id)
    if user is None:
        raise RuntimeError("user not found")
    return user


def _dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_dump(item) for item in value]
    return value


@spawn_mcp.tool()
async def list_hosts() -> list[dict[str, Any]]:
    """List Spawn hosts owned by the authenticated user."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await hosts_routes.list_hosts(session=session, user=user))


@spawn_mcp.tool()
async def get_host(host_id: str) -> dict[str, Any]:
    """Get one Spawn host by id."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await hosts_routes.get_host(host_id, session=session, user=user))


@spawn_mcp.tool()
async def rename_host(host_id: str, name: str) -> dict[str, Any]:
    """Rename a Spawn host."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await hosts_routes.patch_host(
                host_id,
                schemas.HostPatch(name=name),
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def delete_host(host_id: str) -> dict[str, Any]:
    """Delete a Spawn host and revoke its connected daemon if present."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        await hosts_routes.delete_host(host_id, session=session, user=user)
        return {"host_id": host_id, "deleted": True}


@spawn_mcp.tool()
async def list_host_dirs(host_id: str, path: str | None = None) -> dict[str, Any]:
    """List directories on an online host."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await hosts_routes.list_host_dirs(host_id, path=path, session=session, user=user))


@spawn_mcp.tool()
async def list_host_tools(host_id: str) -> dict[str, Any]:
    """Check agent CLI install/update status on a host."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await hosts_routes.list_host_tools(host_id, session=session, user=user))


@spawn_mcp.tool()
async def install_host_tool(host_id: str, preset_id: str) -> dict[str, Any]:
    """Run a preset install/update command on an online host."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await hosts_routes.install_host_tool(
                host_id,
                preset_id,
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def set_host_tool_auto_update(
    host_id: str,
    preset_id: str,
    auto_update: bool,
) -> dict[str, Any]:
    """Enable or disable auto-update for a host/preset tool."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await hosts_routes.patch_host_tool_policy(
                host_id,
                preset_id,
                schemas.HostToolPolicyPatch(auto_update=auto_update),
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def list_presets() -> list[dict[str, Any]]:
    """List built-in and user-defined agent presets."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await presets_routes.list_presets(session=session, user=user))


@spawn_mcp.tool()
async def create_preset(
    name: str,
    agent_kind: str,
    default_argv: list[str],
    env_template: dict[str, str] | None = None,
    install: str | None = None,
) -> dict[str, Any]:
    """Create a user preset."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.PresetCreate(
            name=name,
            agent_kind=agent_kind,
            default_argv=default_argv,
            env_template=env_template or {},
            install=install,
        )
        return _dump(await presets_routes.create_preset(body, session=session, user=user))


@spawn_mcp.tool()
async def update_preset(
    preset_id: str,
    name: str | None = None,
    agent_kind: str | None = None,
    default_argv: list[str] | None = None,
    env_template: dict[str, str] | None = None,
    install: str | None = None,
) -> dict[str, Any]:
    """Update a user preset."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        patch: dict[str, Any] = {}
        if name is not None:
            patch["name"] = name
        if agent_kind is not None:
            patch["agent_kind"] = agent_kind
        if default_argv is not None:
            patch["default_argv"] = default_argv
        if env_template is not None:
            patch["env_template"] = env_template
        if install is not None:
            patch["install"] = install
        body = schemas.PresetPatch.model_validate(patch)
        return _dump(await presets_routes.update_preset(preset_id, body, session=session, user=user))


@spawn_mcp.tool()
async def delete_preset(preset_id: str) -> dict[str, Any]:
    """Delete a user preset."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        await presets_routes.delete_preset(preset_id, session=session, user=user)
        return {"deleted": True, "preset_id": preset_id}


@spawn_mcp.tool()
async def list_mcp_servers() -> list[dict[str, Any]]:
    """List managed MCP servers available to agents."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await capabilities_routes.list_mcp_servers(session=session, user=user))


@spawn_mcp.tool()
async def create_mcp_server(
    name: str,
    transport: str = "streamable_http",
    url: str | None = None,
    command: str | None = None,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    enabled_by_default: bool = False,
) -> dict[str, Any]:
    """Create a managed MCP server definition."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.McpServerCreate(
            name=name,
            transport=transport,  # type: ignore[arg-type]
            url=url,
            command=command,
            args=args or [],
            env=env or {},
            headers=headers or {},
            enabled_by_default=enabled_by_default,
        )
        return _dump(await capabilities_routes.create_mcp_server(body, session=session, user=user))


@spawn_mcp.tool()
async def create_spawn_mcp_server(
    name: str = "spawn",
    enabled_by_default: bool = False,
) -> dict[str, Any]:
    """Create or refresh a managed MCP server entry pointing at this Spawn server."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.SpawnMcpServerCreate(name=name, enabled_by_default=enabled_by_default)
        return _dump(
            await capabilities_routes.create_spawn_mcp_server(body, session=session, user=user)
        )


@spawn_mcp.tool()
async def update_mcp_server(
    server_id: str,
    name: str | None = None,
    transport: str | None = None,
    url: str | None = None,
    command: str | None = None,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    enabled_by_default: bool | None = None,
) -> dict[str, Any]:
    """Update a managed MCP server definition."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.McpServerPatch(
            name=name,
            transport=transport,  # type: ignore[arg-type]
            url=url,
            command=command,
            args=args,
            env=env,
            headers=headers,
            enabled_by_default=enabled_by_default,
        )
        return _dump(
            await capabilities_routes.update_mcp_server(server_id, body, session=session, user=user)
        )


@spawn_mcp.tool()
async def delete_mcp_server(server_id: str) -> dict[str, Any]:
    """Delete a managed MCP server definition."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        await capabilities_routes.delete_mcp_server(server_id, session=session, user=user)
        return {"deleted": True, "mcp_server_id": server_id}


@spawn_mcp.tool()
async def list_skills() -> list[dict[str, Any]]:
    """List managed skills available to agents."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await capabilities_routes.list_skills(session=session, user=user))


@spawn_mcp.tool()
async def create_skill(
    name: str,
    content: str,
    description: str = "",
    enabled_by_default: bool = False,
) -> dict[str, Any]:
    """Create a managed skill."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.SkillCreate(
            name=name,
            description=description,
            content=content,
            enabled_by_default=enabled_by_default,
        )
        return _dump(await capabilities_routes.create_skill(body, session=session, user=user))


@spawn_mcp.tool()
async def update_skill(
    skill_id: str,
    name: str | None = None,
    description: str | None = None,
    content: str | None = None,
    enabled_by_default: bool | None = None,
) -> dict[str, Any]:
    """Update a managed skill."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.SkillPatch(
            name=name,
            description=description,
            content=content,
            enabled_by_default=enabled_by_default,
        )
        return _dump(await capabilities_routes.update_skill(skill_id, body, session=session, user=user))


@spawn_mcp.tool()
async def delete_skill(skill_id: str) -> dict[str, Any]:
    """Delete a managed skill."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        await capabilities_routes.delete_skill(skill_id, session=session, user=user)
        return {"deleted": True, "skill_id": skill_id}


@spawn_mcp.tool()
async def get_agent_access(agent_id: str) -> dict[str, Any]:
    """Get MCP server and skill grants for an agent."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await capabilities_routes.get_agent_access_payload(
                session, user=user, agent_id=agent_id
            )
        )


@spawn_mcp.tool()
async def set_agent_access(
    agent_id: str,
    mcp_server_ids: list[str] | None = None,
    skill_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Replace MCP server and/or skill grants for an agent."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.AgentAccessPatch(mcp_server_ids=mcp_server_ids, skill_ids=skill_ids)
        return _dump(
            await capabilities_routes.update_agent_access(
                agent_id,
                body,
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def list_agents(
    host_id: str | None = None,
    include_archived: bool = False,
) -> list[dict[str, Any]]:
    """List Spawn agents. Returned agents include tmux_session for terminal cooperation."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await agents_routes.list_agents(
                host_id=host_id,
                include_archived=include_archived,
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def get_agent(agent_id: str) -> dict[str, Any]:
    """Get one Spawn agent by id."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(await agents_routes.get_agent(agent_id, session=session, user=user))


@spawn_mcp.tool()
async def create_agent(
    host_id: str,
    cwd: str,
    preset_id: str | None = None,
    argv: list[str] | None = None,
    name: str | None = None,
    env: dict[str, str] | None = None,
    mcp_server_ids: list[str] | None = None,
    skill_ids: list[str] | None = None,
    cols: int = 120,
    rows: int = 32,
    create_cwd: bool = True,
) -> dict[str, Any]:
    """Create and launch an agent on a host."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        body = schemas.AgentCreate(
            name=name,
            host_id=host_id,
            preset_id=preset_id,
            cwd=cwd,
            argv=argv,
            env=env,
            mcp_server_ids=mcp_server_ids,
            skill_ids=skill_ids,
            cols=cols,
            rows=rows,
            create_cwd=create_cwd,
        )
        return _dump(await agents_routes.create_agent(body, session=session, user=user))


@spawn_mcp.tool()
async def rename_agent(agent_id: str, name: str) -> dict[str, Any]:
    """Rename an agent and sync its tmux session name."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await agents_routes.patch_agent(
                agent_id,
                schemas.AgentPatch(name=name),
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def pin_agent(agent_id: str, pinned: bool) -> dict[str, Any]:
    """Pin or unpin an agent."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await agents_routes.patch_agent(
                agent_id,
                schemas.AgentPatch(pinned=pinned),
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def archive_agent(agent_id: str, archived: bool) -> dict[str, Any]:
    """Archive or unarchive an agent."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await agents_routes.patch_agent(
                agent_id,
                schemas.AgentPatch(archived=archived),
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def restart_agent(
    agent_id: str,
    cols: int = 120,
    rows: int = 32,
    create_cwd: bool = True,
) -> dict[str, Any]:
    """Restart an existing agent with its saved argv/env/cwd."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return _dump(
            await agents_routes.restart_agent(
                agent_id,
                schemas.AgentRestart(cols=cols, rows=rows, create_cwd=create_cwd),
                session=session,
                user=user,
            )
        )


@spawn_mcp.tool()
async def delete_agent(agent_id: str) -> dict[str, Any]:
    """Kill and delete an agent."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        await agents_routes.delete_agent(agent_id, session=session, user=user)
        return {"deleted": True, "agent_id": agent_id}


@spawn_mcp.tool()
async def send_agent_input(
    agent_id: str,
    text: str | None = None,
    bytes_b64: str | None = None,
) -> dict[str, Any]:
    """Send text or base64-encoded bytes to an agent terminal."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return await agent_control.send_agent_input(
            session=session,
            user=user,
            agent_id=agent_id,
            text=text,
            bytes_b64=bytes_b64,
        )


@spawn_mcp.tool()
async def resize_agent(agent_id: str, cols: int, rows: int) -> dict[str, Any]:
    """Resize an agent terminal."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return await agent_control.resize_agent(
            session=session,
            user=user,
            agent_id=agent_id,
            cols=cols,
            rows=rows,
        )


@spawn_mcp.tool()
async def scroll_agent(agent_id: str, lines: int) -> dict[str, Any]:
    """Scroll an agent terminal history. Negative scrolls up; positive scrolls down."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return await agent_control.scroll_agent(
            session=session,
            user=user,
            agent_id=agent_id,
            lines=lines,
        )


@spawn_mcp.tool()
async def redraw_agent(agent_id: str) -> dict[str, Any]:
    """Ask the daemon to redraw an agent terminal."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return await agent_control.redraw_agent(session=session, user=user, agent_id=agent_id)


@spawn_mcp.tool()
async def snapshot_agent(
    agent_id: str,
    lines: int = 5000,
    plain: bool = False,
) -> dict[str, Any]:
    """Capture an agent terminal snapshot as base64-encoded terminal bytes."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return await agent_control.snapshot_agent(
            session=session,
            user=user,
            agent_id=agent_id,
            lines=lines,
            plain=plain,
        )


@spawn_mcp.tool()
async def upload_agent_file(
    agent_id: str,
    name: str,
    mime_type: str,
    bytes_b64: str,
    paste: bool = True,
    destination: str | None = None,
) -> dict[str, Any]:
    """Upload a file to an agent. Use destination='cwd' for general files; images can be pasted."""
    async with get_sessionmaker()() as session:
        user = await _mcp_user(session)
        return await agent_control.upload_agent_file(
            session=session,
            user=user,
            agent_id=agent_id,
            name=name,
            mime_type=mime_type,
            bytes_b64=bytes_b64,
            paste=paste,
            destination=destination,
        )


mcp_app = spawn_mcp.streamable_http_app()
