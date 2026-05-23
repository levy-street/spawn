"""Managed MCP server and skill access for agents."""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..models import Agent, AgentMcpServerGrant, AgentSkillGrant, McpServer, Skill, User

router = APIRouter(prefix="/api", tags=["capabilities"])


def _normalize_name(name: str) -> str:
    value = name.strip()
    if not value:
        raise HTTPException(status_code=400, detail="name is required")
    return value


def _validate_mcp_server(body: schemas.McpServerCreate | schemas.McpServerPatch) -> None:
    transport = body.transport
    if transport == "streamable_http" and not getattr(body, "url", None):
        raise HTTPException(status_code=400, detail="streamable_http servers require url")
    if transport == "stdio" and not getattr(body, "command", None):
        raise HTTPException(status_code=400, detail="stdio servers require command")


async def _get_owned_mcp_server(
    session: AsyncSession, server_id: str, user: User
) -> McpServer:
    server = await session.get(McpServer, server_id)
    if server is None or server.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="mcp server not found")
    return server


async def _get_owned_skill(session: AsyncSession, skill_id: str, user: User) -> Skill:
    skill = await session.get(Skill, skill_id)
    if skill is None or skill.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="skill not found")
    return skill


async def _get_owned_agent(session: AsyncSession, agent_id: str, user: User) -> Agent:
    agent = await session.get(Agent, agent_id)
    if agent is None or agent.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="agent not found")
    return agent


async def _owned_mcp_servers_by_ids(
    session: AsyncSession, user: User, ids: Sequence[str]
) -> list[McpServer]:
    if not ids:
        return []
    rows = (
        await session.execute(
            select(McpServer).where(McpServer.owner_user_id == user.id, McpServer.id.in_(ids))
        )
    ).scalars().all()
    by_id = {row.id: row for row in rows}
    missing = [server_id for server_id in ids if server_id not in by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"mcp server not found: {missing[0]}")
    return [by_id[server_id] for server_id in ids]


async def _owned_skills_by_ids(session: AsyncSession, user: User, ids: Sequence[str]) -> list[Skill]:
    if not ids:
        return []
    rows = (
        await session.execute(select(Skill).where(Skill.owner_user_id == user.id, Skill.id.in_(ids)))
    ).scalars().all()
    by_id = {row.id: row for row in rows}
    missing = [skill_id for skill_id in ids if skill_id not in by_id]
    if missing:
        raise HTTPException(status_code=404, detail=f"skill not found: {missing[0]}")
    return [by_id[skill_id] for skill_id in ids]


async def default_mcp_server_ids(session: AsyncSession, user: User) -> list[str]:
    rows = (
        await session.execute(
            select(McpServer.id)
            .where(McpServer.owner_user_id == user.id, McpServer.enabled_by_default.is_(True))
            .order_by(McpServer.name)
        )
    ).scalars().all()
    return list(rows)


async def default_skill_ids(session: AsyncSession, user: User) -> list[str]:
    rows = (
        await session.execute(
            select(Skill.id)
            .where(Skill.owner_user_id == user.id, Skill.enabled_by_default.is_(True))
            .order_by(Skill.name)
        )
    ).scalars().all()
    return list(rows)


async def set_agent_access(
    session: AsyncSession,
    *,
    user: User,
    agent: Agent,
    mcp_server_ids: Sequence[str],
    skill_ids: Sequence[str],
) -> None:
    await _owned_mcp_servers_by_ids(session, user, mcp_server_ids)
    await _owned_skills_by_ids(session, user, skill_ids)

    await session.execute(delete(AgentMcpServerGrant).where(AgentMcpServerGrant.agent_id == agent.id))
    await session.execute(delete(AgentSkillGrant).where(AgentSkillGrant.agent_id == agent.id))
    for server_id in dict.fromkeys(mcp_server_ids):
        session.add(
            AgentMcpServerGrant(
                owner_user_id=user.id,
                agent_id=agent.id,
                mcp_server_id=server_id,
            )
        )
    for skill_id in dict.fromkeys(skill_ids):
        session.add(
            AgentSkillGrant(
                owner_user_id=user.id,
                agent_id=agent.id,
                skill_id=skill_id,
            )
        )


async def get_agent_access_payload(
    session: AsyncSession, *, user: User, agent_id: str
) -> schemas.AgentAccessOut:
    agent = await _get_owned_agent(session, agent_id, user)
    mcp_servers = (
        await session.execute(
            select(McpServer)
            .join(AgentMcpServerGrant, AgentMcpServerGrant.mcp_server_id == McpServer.id)
            .where(
                AgentMcpServerGrant.agent_id == agent.id,
                AgentMcpServerGrant.owner_user_id == user.id,
            )
            .order_by(McpServer.name)
        )
    ).scalars().all()
    skills = (
        await session.execute(
            select(Skill)
            .join(AgentSkillGrant, AgentSkillGrant.skill_id == Skill.id)
            .where(AgentSkillGrant.agent_id == agent.id, AgentSkillGrant.owner_user_id == user.id)
            .order_by(Skill.name)
        )
    ).scalars().all()
    return schemas.AgentAccessOut(
        agent_id=agent.id,
        mcp_servers=[schemas.McpServerOut.model_validate(row) for row in mcp_servers],
        skills=[schemas.SkillOut.model_validate(row) for row in skills],
    )


async def get_agent_launch_capabilities(
    session: AsyncSession, *, user: User, agent_id: str
) -> tuple[list[dict], list[dict]]:
    access = await get_agent_access_payload(session, user=user, agent_id=agent_id)
    mcp_servers = [
        schemas.AgentMcpServerConfig(
            id=server.id,
            name=server.name,
            transport=server.transport,
            url=server.url,
            command=server.command,
            args=server.args,
            env=server.env,
            headers=server.headers,
        ).model_dump(mode="json")
        for server in access.mcp_servers
    ]
    skills = [
        schemas.AgentSkillConfig(
            id=skill.id,
            name=skill.name,
            description=skill.description,
            content=skill.content,
        ).model_dump(mode="json")
        for skill in access.skills
    ]
    return mcp_servers, skills


@router.get("/mcp-servers", response_model=list[schemas.McpServerOut])
async def list_mcp_servers(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.McpServerOut]:
    rows = (
        await session.execute(
            select(McpServer).where(McpServer.owner_user_id == user.id).order_by(McpServer.name)
        )
    ).scalars().all()
    return [schemas.McpServerOut.model_validate(row) for row in rows]


@router.post("/mcp-servers", response_model=schemas.McpServerOut, status_code=status.HTTP_201_CREATED)
async def create_mcp_server(
    body: schemas.McpServerCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.McpServerOut:
    _validate_mcp_server(body)
    server = McpServer(
        owner_user_id=user.id,
        name=_normalize_name(body.name),
        transport=body.transport,
        url=body.url.strip() if body.url else None,
        command=body.command.strip() if body.command else None,
        args=list(body.args),
        env=dict(body.env),
        headers=dict(body.headers),
        enabled_by_default=body.enabled_by_default,
    )
    session.add(server)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="mcp server name already exists") from e
    await session.refresh(server)
    return schemas.McpServerOut.model_validate(server)


@router.post(
    "/mcp-servers/spawn",
    response_model=schemas.McpServerOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_spawn_mcp_server(
    body: schemas.SpawnMcpServerCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.McpServerOut:
    name = _normalize_name(body.name)
    url = f"{get_settings().public_url.rstrip('/')}/mcp"
    headers = {"Authorization": f"Bearer {auth.issue_session_token(user.id)}"}
    existing = (
        await session.execute(
            select(McpServer).where(McpServer.owner_user_id == user.id, McpServer.name == name)
        )
    ).scalar_one_or_none()
    if existing is None:
        existing = McpServer(owner_user_id=user.id, name=name)
        session.add(existing)
    existing.transport = "streamable_http"
    existing.url = url
    existing.command = None
    existing.args = []
    existing.env = {}
    existing.headers = headers
    existing.enabled_by_default = body.enabled_by_default
    await session.commit()
    await session.refresh(existing)
    return schemas.McpServerOut.model_validate(existing)


@router.patch("/mcp-servers/{server_id}", response_model=schemas.McpServerOut)
async def update_mcp_server(
    server_id: str,
    body: schemas.McpServerPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.McpServerOut:
    server = await _get_owned_mcp_server(session, server_id, user)
    if body.name is not None:
        server.name = _normalize_name(body.name)
    if body.transport is not None:
        server.transport = body.transport
    if body.url is not None:
        server.url = body.url.strip() or None
    if body.command is not None:
        server.command = body.command.strip() or None
    if body.args is not None:
        server.args = list(body.args)
    if body.env is not None:
        server.env = dict(body.env)
    if body.headers is not None:
        server.headers = dict(body.headers)
    if body.enabled_by_default is not None:
        server.enabled_by_default = body.enabled_by_default
    _validate_mcp_server(
        schemas.McpServerCreate(
            name=server.name,
            transport=server.transport,  # type: ignore[arg-type]
            url=server.url,
            command=server.command,
            args=server.args,
            env=server.env,
            headers=server.headers,
            enabled_by_default=server.enabled_by_default,
        )
    )
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="mcp server name already exists") from e
    await session.refresh(server)
    return schemas.McpServerOut.model_validate(server)


@router.delete("/mcp-servers/{server_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_mcp_server(
    server_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    server = await _get_owned_mcp_server(session, server_id, user)
    await session.delete(server)
    await session.commit()


@router.get("/skills", response_model=list[schemas.SkillOut])
async def list_skills(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.SkillOut]:
    rows = (
        await session.execute(select(Skill).where(Skill.owner_user_id == user.id).order_by(Skill.name))
    ).scalars().all()
    return [schemas.SkillOut.model_validate(row) for row in rows]


@router.post("/skills", response_model=schemas.SkillOut, status_code=status.HTTP_201_CREATED)
async def create_skill(
    body: schemas.SkillCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SkillOut:
    skill = Skill(
        owner_user_id=user.id,
        name=_normalize_name(body.name),
        description=body.description.strip(),
        content=body.content,
        enabled_by_default=body.enabled_by_default,
    )
    session.add(skill)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="skill name already exists") from e
    await session.refresh(skill)
    return schemas.SkillOut.model_validate(skill)


@router.patch("/skills/{skill_id}", response_model=schemas.SkillOut)
async def update_skill(
    skill_id: str,
    body: schemas.SkillPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.SkillOut:
    skill = await _get_owned_skill(session, skill_id, user)
    if body.name is not None:
        skill.name = _normalize_name(body.name)
    if body.description is not None:
        skill.description = body.description.strip()
    if body.content is not None:
        skill.content = body.content
    if body.enabled_by_default is not None:
        skill.enabled_by_default = body.enabled_by_default
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(status_code=409, detail="skill name already exists") from e
    await session.refresh(skill)
    return schemas.SkillOut.model_validate(skill)


@router.delete("/skills/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(
    skill_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    skill = await _get_owned_skill(session, skill_id, user)
    await session.delete(skill)
    await session.commit()


@router.get("/agents/{agent_id}/access", response_model=schemas.AgentAccessOut)
async def get_agent_access(
    agent_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentAccessOut:
    return await get_agent_access_payload(session, user=user, agent_id=agent_id)


@router.patch("/agents/{agent_id}/access", response_model=schemas.AgentAccessOut)
async def update_agent_access(
    agent_id: str,
    body: schemas.AgentAccessPatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.AgentAccessOut:
    agent = await _get_owned_agent(session, agent_id, user)
    current = await get_agent_access_payload(session, user=user, agent_id=agent.id)
    mcp_ids = body.mcp_server_ids
    if mcp_ids is None:
        mcp_ids = [server.id for server in current.mcp_servers]
    skill_ids = body.skill_ids
    if skill_ids is None:
        skill_ids = [skill.id for skill in current.skills]
    await set_agent_access(
        session,
        user=user,
        agent=agent,
        mcp_server_ids=mcp_ids,
        skill_ids=skill_ids,
    )
    await session.commit()
    return await get_agent_access_payload(session, user=user, agent_id=agent.id)
