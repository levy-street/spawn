"""Email/password signup, login, logout, /api/me."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, billing_stripe, rate_limit, schemas
from ..config import get_settings
from ..db import get_session
from ..invites import is_first_account, redeem_invite, signup_is_open
from ..models import AuthIdentity, Host, HostKeyClaim, Subscription, User
from ..ws.broker import get_broker
from .account_recovery import send_verification_email

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])


def _set_session_cookie(response: Response, token: str) -> None:
    auth.set_session_cookie(response, token)


@router.post(
    "/auth/signup",
    response_model=schemas.TokenResponse,
    dependencies=[Depends(rate_limit.limiter(rate_limit.SIGNUP))],
)
async def signup(
    body: schemas.SignupRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    email = auth.normalize_email(body.email)
    existing = (
        await session.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already in use")

    # A closed deployment needs an invite, except for the very first account:
    # an empty install has nobody who could have issued one, and that account
    # becomes the owner.
    invite = None
    # Two different questions: may this signup proceed without an invite, and
    # is this the deployment's first account (which owns it). On an open
    # deployment the first is always true and the second almost never is.
    first_account = await is_first_account(session)
    if not await signup_is_open(session):
        if not body.invite:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="spawn is invite only right now",
            )
        try:
            invite = await redeem_invite(session, body.invite)
        except ValueError as cause:
            # One message for every failure mode (unknown, used, expired,
            # revoked): a stranger probing codes learns nothing from the
            # difference.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="this invite is not valid",
            ) from cause

    user = User(
        email=email,
        password_hash=auth.hash_password(body.password),
        is_admin=first_account or auth.email_is_bootstrap_admin(email),
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="email already in use"
        ) from e
    await session.refresh(user)
    if invite is not None:
        invite.used_at = datetime.now(UTC)
        invite.used_by_user_id = user.id
        await session.commit()
    # Best effort: a mail outage must not block account creation, and the user
    # can request another from Settings.
    await send_verification_email(session, user)
    await session.commit()
    await session.refresh(user)
    access_token = auth.issue_access_token(user.id, user.session_epoch)
    _set_session_cookie(response, auth.issue_session_token(user.id, user.session_epoch))
    return schemas.TokenResponse(
        access_token=access_token, user=await schemas.user_out(session, user)
    )


@router.post(
    "/auth/login",
    response_model=schemas.TokenResponse,
    dependencies=[Depends(rate_limit.limiter(rate_limit.LOGIN))],
)
async def login(
    body: schemas.LoginRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> schemas.TokenResponse:
    email = auth.normalize_email(body.email)
    row = (
        await session.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if row is None or not auth.verify_password(body.password, row.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    # Bootstrap admin from configuration so reaching the admin surface never
    # requires hand-editing rows.
    if not row.is_admin and auth.email_is_bootstrap_admin(row.email):
        row.is_admin = True
        await session.commit()
        await session.refresh(row)
    access_token = auth.issue_access_token(row.id, row.session_epoch)
    _set_session_cookie(response, auth.issue_session_token(row.id, row.session_epoch))
    return schemas.TokenResponse(
        access_token=access_token, user=await schemas.user_out(session, row)
    )


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    response.delete_cookie(
        "spawn_session",
        samesite="lax",
        secure=get_settings().public_url.startswith("https://"),
    )


@router.get("/me", response_model=schemas.MeResponse)
async def me(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.MeResponse:
    return schemas.MeResponse(user=await schemas.user_out(session, user))


def _fresh_session(response: Response, user_id: str, epoch: int) -> tuple[str, datetime]:
    token = auth.issue_session_token(user_id, epoch)
    expires_at = datetime.fromtimestamp(auth.decode_token(token)["exp"], UTC)
    _set_session_cookie(response, token)
    return token, expires_at


@router.post("/auth/session/renew", response_model=schemas.SessionRenewResponse)
async def renew_session(
    request: Request,
    response: Response,
    _body: schemas.EmptyRequest | None = None,
    user: User = Depends(auth.current_user),
) -> schemas.SessionRenewResponse:
    token, expires_at = _fresh_session(response, user.id, user.session_epoch)
    request.state.session_renewal_token = None
    return schemas.SessionRenewResponse(access_token=token, expires_at=expires_at)


@router.post("/auth/sign-out-everywhere", response_model=schemas.SessionTokenResponse)
async def sign_out_everywhere(
    request: Request,
    response: Response,
    _body: schemas.EmptyRequest | None = None,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.SessionTokenResponse:
    epoch = (
        await session.execute(
            update(User)
            .where(User.id == user.id)
            .values(session_epoch=User.session_epoch + 1)
            .returning(User.session_epoch)
            .execution_options(synchronize_session=False)
        )
    ).scalar_one()
    await session.commit()
    token, _expires_at = _fresh_session(response, user.id, int(epoch))
    request.state.session_renewal_token = None
    return schemas.SessionTokenResponse(access_token=token)


@router.post("/account/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    body: schemas.AccountDeleteRequest,
    response: Response,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Permanently delete the signed-in account and everything it owns.

    Two-factor confirmation: the caller must retype the account email (wrong-
    account protection), and an account that was created with a password must
    present it (session theft protection). Provider-created accounts carry an
    unusable random hash no one can type, so for accounts with a linked auth
    identity the typed email alone suffices — their session came from the
    provider's own authentication.

    Host key claims are ``ondelete=RESTRICT`` precisely so that deleting a
    user can never RELEASE host identity keys as a side effect; an account
    deletion is the one deliberate act that does release them, so they are
    deleted explicitly here before the user row cascades everything else.
    Live daemon sockets for the account's hosts are closed best-effort — their
    tokens are already dead (every request re-resolves the user row).

    A Stripe subscription is cancelled first, for the mirror image of that
    reason: its row is ``ondelete=CASCADE``, so leaving it to the cascade
    would stop the record without stopping the charge.
    """

    if body.confirm_email.strip().lower() != user.email.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="confirmation email does not match this account",
        )
    password_ok = body.password is not None and auth.verify_password(
        body.password, user.password_hash
    )
    if not password_ok:
        has_identity = (
            await session.execute(
                select(func.count())
                .select_from(AuthIdentity)
                .where(AuthIdentity.user_id == user.id)
            )
        ).scalar_one() > 0
        if not has_identity or body.password is not None:
            # Password accounts must present the password; a supplied-but-wrong
            # password is rejected even for provider accounts.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="password confirmation failed",
            )

    # Billing goes first, by hand, and deliberately not via the cascade.
    # `Subscription` is `ondelete="CASCADE"`, so deleting the user row would
    # drop our only local record of a live Stripe subscription while Stripe
    # went on charging the card every month — a money bug that erases its own
    # evidence. The host key claims below are the same class of work for the
    # opposite reason (their FK is RESTRICT); both are here because a cascade
    # cannot reach outside this database.
    if get_settings().billing_enabled:
        subscription = (
            await session.execute(select(Subscription).where(Subscription.user_id == user.id))
        ).scalar_one_or_none()
        if subscription is not None:
            # Captured before the call: after a failure these ids are the only
            # way anyone finds the subscription again.
            customer_id = subscription.stripe_customer_id
            subscription_id = subscription.stripe_subscription_id
            try:
                await billing_stripe.cancel_subscription_for_user(session, user)
            except Exception as exc:
                # The deletion proceeds anyway. Somebody's right to delete
                # their account cannot be held up by our payment processor
                # being unreachable — but it now needs a human, so this is an
                # error an operator can act on without reading any code.
                log.error(
                    "ACCOUNT DELETED WITH A LIVE STRIPE SUBSCRIPTION - cancel it by hand "
                    "in the Stripe dashboard: user_id=%s stripe_customer_id=%s "
                    "stripe_subscription_id=%s error=%s",
                    user.id,
                    customer_id,
                    subscription_id,
                    exc,
                )

    host_ids = (
        (await session.execute(select(Host.id).where(Host.owner_user_id == user.id)))
        .scalars()
        .all()
    )
    await session.execute(delete(HostKeyClaim).where(HostKeyClaim.owner_user_id == user.id))
    await session.execute(delete(User).where(User.id == user.id))
    await session.commit()

    for host_id in host_ids:
        try:
            daemon = get_broker().get_daemon_for_host(host_id)
            if daemon is not None:
                await daemon.close()
        except Exception:
            pass

    response.delete_cookie(
        "spawn_session",
        samesite="lax",
        secure=get_settings().public_url.startswith("https://"),
    )
