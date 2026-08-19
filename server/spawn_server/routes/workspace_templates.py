"""`/api/workspace-templates` — saved workspace shapes.

A template captures a workspace's structure (tabs, tile geometry, and what
each tile runs) without its folder or host; the client re-plays it against a
freshly chosen folder when creating a workspace from it. The server's job is
storage plus the same geometry validation layouts get.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, grid, schemas
from ..db import get_session
from ..models import Host, User, WorkspaceTemplate

router = APIRouter(prefix="/api/workspace-templates", tags=["workspace-templates"])


def _validated_spec(spec: schemas.WorkspaceTemplateSpec) -> dict:
    for tab in spec.tabs:
        synthetic = [
            {"session_id": f"t{index}", "x": tile.x, "y": tile.y, "w": tile.w, "h": tile.h}
            for index, tile in enumerate(tab.tiles)
        ]
        if not grid.validate_layout({"version": 2, "tiles": synthetic})["ok"]:
            raise HTTPException(status_code=400, detail="invalid_template_geometry")
        for tile in tab.tiles:
            command = (tile.run.command or "").strip()
            if tile.run.kind == "agent" and not command:
                raise HTTPException(status_code=400, detail="agent tiles need a command")
            if tile.run.kind != "agent" and command:
                raise HTTPException(status_code=400, detail="only agent tiles carry a command")
    return spec.model_dump()


async def _validated_home(
    session: AsyncSession, user: User, host_id: str | None, cwd: str | None
) -> tuple[str | None, str | None]:
    if host_id is None:
        return None, cwd.strip() if cwd and cwd.strip() else None
    host = await session.get(Host, host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
    clean = (cwd or "").strip()
    if not clean:
        raise HTTPException(status_code=400, detail="cwd is required with host_id")
    return host.id, clean


async def _template_or_404(
    session: AsyncSession, user: User, template_id: str
) -> WorkspaceTemplate:
    template = await session.get(WorkspaceTemplate, template_id)
    if template is None or template.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="template not found")
    return template


@router.get("", response_model=list[schemas.WorkspaceTemplateOut])
async def list_templates(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> list[schemas.WorkspaceTemplateOut]:
    rows = (
        (
            await session.execute(
                select(WorkspaceTemplate)
                .where(WorkspaceTemplate.owner_user_id == user.id)
                .order_by(WorkspaceTemplate.name)
            )
        )
        .scalars()
        .all()
    )
    return [schemas.WorkspaceTemplateOut.model_validate(row) for row in rows]


@router.post(
    "", response_model=schemas.WorkspaceTemplateOut, status_code=status.HTTP_201_CREATED
)
async def create_template(
    body: schemas.WorkspaceTemplateCreate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceTemplateOut:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="template name is required")
    host_id, cwd = await _validated_home(session, user, body.host_id, body.cwd)
    template = WorkspaceTemplate(
        owner_user_id=user.id,
        name=name,
        host_id=host_id,
        cwd=cwd,
        spec=_validated_spec(body.spec),
    )
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return schemas.WorkspaceTemplateOut.model_validate(template)


@router.patch("/{template_id}", response_model=schemas.WorkspaceTemplateOut)
async def update_template(
    template_id: str,
    body: schemas.WorkspaceTemplatePatch,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.WorkspaceTemplateOut:
    template = await _template_or_404(session, user, template_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="template name is required")
        template.name = name
    if body.host_id is not None or body.cwd is not None:
        template.host_id, template.cwd = await _validated_home(
            session,
            user,
            body.host_id if body.host_id is not None else template.host_id,
            body.cwd if body.cwd is not None else template.cwd,
        )
    if body.spec is not None:
        template.spec = _validated_spec(body.spec)
    await session.commit()
    await session.refresh(template)
    return schemas.WorkspaceTemplateOut.model_validate(template)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: str,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> None:
    template = await _template_or_404(session, user, template_id)
    await session.delete(template)
    await session.commit()
