"""Remote alert delivery: registration, copy, and dead-token retirement."""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select

from spawn_server.config import Settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import PushDevice
from spawn_server.push import (
    alert_push_message,
    approval_push_message,
    pairing_push_message,
    send_alert_push,
    send_approval_push,
    send_pairing_push,
)

TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"
OTHER_TOKEN = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]"


async def _account(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "a-long-enough-password"},
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


class TestAlertCopy:
    def test_a_finish_names_the_command(self):
        message = alert_push_message(
            {"event": "agent.finished", "session_id": "s-1", "command": "claude"}
        )
        assert message is not None
        assert message.title == "claude finished"
        # The session id rides in data, which is never rendered on a lock screen.
        assert message.data == {"sessionId": "s-1", "event": "agent.finished"}

    def test_waiting_reads_as_waiting(self):
        message = alert_push_message(
            {"event": "agent.awaiting_input", "session_id": "s-1", "command": "codex"}
        )
        assert message is not None
        assert message.title == "codex is waiting for you"

    def test_a_signal_reads_as_a_kill_and_carries_the_signal(self):
        message = alert_push_message(
            {"event": "session.died", "session_id": "s-1", "command": "vim", "signal": "SIGKILL"}
        )
        assert message is not None
        assert message.title == "vim was killed"
        assert message.body == "SIGKILL"

    def test_an_exit_code_reads_as_an_exit(self):
        message = alert_push_message(
            {"event": "session.died", "session_id": "s-1", "command": "vim", "exit_code": 2}
        )
        assert message is not None
        assert message.title == "vim exited"
        assert message.body == "Exit 2"

    def test_a_missing_command_still_produces_sendable_copy(self):
        message = alert_push_message({"event": "agent.finished", "session_id": "s-1"})
        assert message is not None
        assert message.title == "A session finished"

    @pytest.mark.parametrize(
        "payload",
        [
            {"event": "session.opened", "session_id": "s-1"},
            {"event": "agent.finished"},
            {"session_id": "s-1"},
            {"event": "agent.finished", "session_id": ""},
        ],
    )
    def test_anything_not_an_alert_stays_silent(self, payload):
        assert alert_push_message(payload) is None


class TestRegistration:
    async def test_registers_and_then_refreshes_the_same_token(self, client):
        _, headers = await _account(client, "push@example.com")

        first = await client.post(
            "/api/notifications/devices",
            json={"token": TOKEN, "platform": "ios", "label": "iPhone"},
            headers=headers,
        )
        assert first.status_code == 200

        # The app re-registers on every launch; that must not pile up rows.
        second = await client.post(
            "/api/notifications/devices",
            json={"token": TOKEN, "platform": "ios", "label": "iPhone 17"},
            headers=headers,
        )
        assert second.status_code == 200
        assert second.json()["id"] == first.json()["id"]
        assert second.json()["label"] == "iPhone 17"

    async def test_a_handset_handed_to_another_account_stops_alerting_the_first(self, client):
        first_user, first_headers = await _account(client, "one@example.com")
        _, second_headers = await _account(client, "two@example.com")

        await client.post(
            "/api/notifications/devices",
            json={"token": TOKEN, "platform": "ios"},
            headers=first_headers,
        )
        await client.post(
            "/api/notifications/devices",
            json={"token": TOKEN, "platform": "ios"},
            headers=second_headers,
        )

        sm = get_sessionmaker()
        async with sm() as session:
            rows = list((await session.execute(select(PushDevice))).scalars())
        assert len(rows) == 1
        assert rows[0].user_id != first_user

    async def test_unregistering_is_scoped_to_the_caller(self, client):
        _, owner = await _account(client, "owner@example.com")
        _, stranger = await _account(client, "stranger@example.com")
        await client.post(
            "/api/notifications/devices",
            json={"token": TOKEN, "platform": "ios"},
            headers=owner,
        )

        # A stranger gets the same 204 and changes nothing, so this cannot be
        # used to probe whether a token belongs to somebody else.
        assert (
            await client.delete(f"/api/notifications/devices/{TOKEN}", headers=stranger)
        ).status_code == 204
        sm = get_sessionmaker()
        async with sm() as session:
            assert len(list((await session.execute(select(PushDevice))).scalars())) == 1

        assert (
            await client.delete(f"/api/notifications/devices/{TOKEN}", headers=owner)
        ).status_code == 204
        async with sm() as session:
            assert list((await session.execute(select(PushDevice))).scalars()) == []

    async def test_registration_requires_a_session(self, client):
        response = await client.post(
            "/api/notifications/devices",
            json={"token": TOKEN, "platform": "ios"},
        )
        assert response.status_code == 401

    async def test_registration_prunes_push_devices_disabled_over_ninety_days(self, client):
        from datetime import UTC, datetime, timedelta

        user_id, headers = await _account(client, "push-retention@example.com")
        now = datetime.now(UTC)
        sm = get_sessionmaker()
        async with sm() as session:
            session.add_all(
                [
                    PushDevice(
                        user_id=user_id,
                        token="ExponentPushToken[old-disabled]",
                        platform="ios",
                        disabled_at=now - timedelta(days=91),
                        created_at=now - timedelta(days=100),
                        last_seen_at=now - timedelta(days=100),
                    ),
                    PushDevice(
                        user_id=user_id,
                        token="ExponentPushToken[recent-disabled]",
                        platform="ios",
                        disabled_at=now - timedelta(days=89),
                        created_at=now - timedelta(days=100),
                        last_seen_at=now - timedelta(days=100),
                    ),
                ]
            )
            await session.commit()

        response = await client.post(
            "/api/notifications/devices",
            json={"token": "ExponentPushToken[new-live]", "platform": "ios"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        async with sm() as session:
            tokens = set((await session.execute(select(PushDevice.token))).scalars())
        assert tokens == {
            "ExponentPushToken[recent-disabled]",
            "ExponentPushToken[new-live]",
        }


class TestDelivery:
    async def _register(self, client, headers, token: str) -> None:
        assert (
            await client.post(
                "/api/notifications/devices",
                json={"token": token, "platform": "ios"},
                headers=headers,
            )
        ).status_code == 200

    async def test_sends_one_message_per_live_install(self, client):
        user_id, headers = await _account(client, "send@example.com")
        await self._register(client, headers, TOKEN)
        await self._register(client, headers, OTHER_TOKEN)

        seen: list[list[dict]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"data": [{"status": "ok"}, {"status": "ok"}]})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload={"event": "agent.finished", "session_id": "s-1", "command": "claude"},
                client=http,
                settings=Settings(),
            )

        assert sent == 2
        assert {message["to"] for message in seen[0]} == {TOKEN, OTHER_TOKEN}
        assert seen[0][0]["title"] == "claude finished"

    async def test_a_token_the_service_disowns_is_retired(self, client):
        user_id, headers = await _account(client, "dead@example.com")
        await self._register(client, headers, TOKEN)

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "status": "error",
                            "message": "not registered",
                            "details": {"error": "DeviceNotRegistered"},
                        }
                    ]
                },
            )

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload={"event": "agent.finished", "session_id": "s-1", "command": "claude"},
                client=http,
                settings=Settings(),
            )
            assert sent == 0
            row = (await session.execute(select(PushDevice))).scalar_one()
            # Kept, not deleted, so a re-register is an update rather than a
            # resurrection of state nobody can account for.
            assert row.disabled_at is not None

    async def test_a_retired_token_is_not_sent_to_again(self, client):
        user_id, headers = await _account(client, "retired@example.com")
        await self._register(client, headers, TOKEN)

        sm = get_sessionmaker()
        async with sm() as session:
            row = (await session.execute(select(PushDevice))).scalar_one()
            from datetime import UTC, datetime

            row.disabled_at = datetime.now(UTC)
            await session.commit()

        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"data": []})

        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload={"event": "agent.finished", "session_id": "s-1", "command": "claude"},
                client=http,
                settings=Settings(),
            )

        assert sent == 0
        assert calls == 0

    async def test_a_failing_push_service_never_reaches_the_caller(self, client):
        """An alert is a courtesy; it must not surface as a broken session."""
        user_id, headers = await _account(client, "broken@example.com")
        await self._register(client, headers, TOKEN)

        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("push service is down")

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload={"event": "agent.finished", "session_id": "s-1", "command": "claude"},
                client=http,
                settings=Settings(),
            )
        assert sent == 0

    async def test_push_can_be_switched_off_entirely(self, client):
        user_id, headers = await _account(client, "off@example.com")
        await self._register(client, headers, TOKEN)

        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"data": [{"status": "ok"}]})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload={"event": "agent.finished", "session_id": "s-1", "command": "claude"},
                client=http,
                settings=Settings(push_enabled=False),
            )

        assert sent == 0
        assert calls == 0

    async def test_an_account_with_no_installs_sends_nothing(self, client):
        user_id, _ = await _account(client, "quiet@example.com")
        sm = get_sessionmaker()
        async with sm() as session:
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload={"event": "agent.finished", "session_id": "s-1", "command": "claude"},
                settings=Settings(),
            )
        assert sent == 0


class TestApprovalPush:
    """The knock (docs/TRUST_UX.md §3) reaching a phone that is closed."""

    def test_the_copy_names_the_asking_device_and_nothing_else(self):
        message = approval_push_message("req-1", "spawn on iPhone")
        assert message.title == "Approve spawn on iPhone?"
        assert message.data == {"event": "device.approval_requested", "requestId": "req-1"}
        # The fingerprint is compared in the prompt, never on a lock screen.
        assert "SHA256" not in message.title + message.body
        assert approval_push_message("req-2", "  ").title == "Approve A new device?"

    def test_pairing_push_routes_to_the_claim_without_exposing_key_material(self):
        message = pairing_push_message("approval-ref", "workstation")
        assert message.title == "SPAWN D"
        assert message.body == "workstation is ready to join your account"
        assert message.data == {
            "event": "host.pair_requested",
            "approvalRef": "approval-ref",
        }
        assert "SHA256" not in message.title + message.body

    async def _register(self, client, headers, token: str, browser_device_id: str | None) -> None:
        body: dict[str, object] = {"token": token, "platform": "ios"}
        if browser_device_id is not None:
            body["browser_device_id"] = browser_device_id
        assert (
            await client.post("/api/notifications/devices", json=body, headers=headers)
        ).status_code == 200

    async def test_the_knocking_phone_is_not_told_about_its_own_knock(self, client):
        user_id, headers = await _account(client, "knock-push@example.com")
        asking = "00000000-0000-4000-8000-000000000aaa"
        await self._register(client, headers, TOKEN, asking)
        await self._register(client, headers, OTHER_TOKEN, "00000000-0000-4000-8000-000000000bbb")

        seen: list[list[dict]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"data": [{"status": "ok"}]})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_approval_push(
                session=session,
                user_id=user_id,
                request_id="req-1",
                label="spawn on iPhone",
                exclude_browser_device_id=asking,
                client=http,
                settings=Settings(),
            )

        assert sent == 1
        assert [message["to"] for message in seen[0]] == [OTHER_TOKEN]
        assert seen[0][0]["title"] == "Approve spawn on iPhone?"
        assert seen[0][0]["data"]["requestId"] == "req-1"

    async def test_pairing_push_reaches_every_install_including_the_knocking_phone(self, client):
        user_id, headers = await _account(client, "pairing-push@example.com")
        await self._register(client, headers, TOKEN, "00000000-0000-4000-8000-000000000aaa")
        await self._register(client, headers, OTHER_TOKEN, "00000000-0000-4000-8000-000000000bbb")
        seen: list[list[dict]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            seen.append(json.loads(request.content))
            return httpx.Response(
                200,
                json={"data": [{"status": "ok"}, {"status": "ok"}]},
            )

        async with (
            get_sessionmaker()() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_pairing_push(
                session=session,
                user_id=user_id,
                approval_ref="approval-ref",
                host_name="workstation",
                client=http,
                settings=Settings(),
            )

        assert sent == 2
        assert {message["to"] for message in seen[0]} == {TOKEN, OTHER_TOKEN}
        assert {message["data"]["approvalRef"] for message in seen[0]} == {"approval-ref"}

    async def test_an_older_app_with_no_device_id_is_still_told(self, client):
        user_id, headers = await _account(client, "knock-legacy@example.com")
        await self._register(client, headers, TOKEN, None)

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": [{"status": "ok"}]})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_approval_push(
                session=session,
                user_id=user_id,
                request_id="req-1",
                label=None,
                exclude_browser_device_id="00000000-0000-4000-8000-000000000aaa",
                client=http,
                settings=Settings(),
            )
        assert sent == 1
