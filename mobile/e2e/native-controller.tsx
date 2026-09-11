// This module is copied into src/ only by prepare-native-acceptance.mjs.
// It runs inside the real authenticated app and never replaces its transports.
import { sha256 } from "@noble/hashes/sha2.js";
import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { authToken } from "@/data/api/auth-token";
import { getBaseUrl } from "@/data/api/config";
import { getMe } from "@/data/api/endpoints/account";
import { logOut } from "@/data/api/endpoints/auth";
import { adoptAuthenticatedAccount } from "@/data/queries/auth";
import { ensureDeviceRegistered } from "@/data/trust/registration";
import { useAuthenticatedAccount } from "@/lib/auth-gate";
import { encodeBase64Url, encodeHex } from "@/lib/crypto/bytes";
import {
  deviceIdentity,
  deviceIdentityGeneration,
  setDeviceIdentityAccount,
} from "@/lib/crypto/identity";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import { TerminalSurface } from "@/terminal/TerminalSurface";
import { retainHostTransport } from "@/terminal/transport/host-transport-registry";
import type { HostTransport, SessionTransport, UploadProgress } from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";

interface Bootstrap {
  runId: string;
  candidateCommit: string;
  accountId: string;
  bearerToken: string;
  hostId: string;
  hostPublicKey: string;
  sessionA: string;
  sessionB: string;
  secondAccount: { accountId: string; bearerToken: string };
}
interface Command {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
}
interface Probe {
  receivedAt: number;
  snapshot: Record<string, unknown>;
}
const probes = new Map<string, Probe>();
export function captureNativePeerStats(hostId: string, snapshot: Record<string, unknown>): void {
  probes.set(hostId, { receivedAt: Date.now(), snapshot });
}
const build = Constants.expoConfig?.extra?.["nativeAcceptance"] as
  | { token: string; candidateCommit: string; sourceClean: boolean; platform: string }
  | undefined;
const launchId = `launch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string, timeout = 60_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error(message);
    await wait(100);
  }
}
async function control<T>(path: string, body?: unknown): Promise<T> {
  if (!build || build.token.length < 32) throw new Error("Acceptance configuration is absent.");
  const origin = new URL(await getBaseUrl());
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "10.0.2.2"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Acceptance refused a non-local fixture.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL(path, origin).toString(), {
      headers: { "Content-Type": "application/json", "X-Acceptance-Token": build.token },
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Acceptance control ${path}: ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
async function event(type: string, details: unknown, commandId?: string, status?: string) {
  await control("/__acceptance/event", {
    type,
    details: {
      schema_kind: Platform.OS === "ios" ? "native_simulator" : "native_emulator",
      candidate_commit: build?.candidateCommit,
      source_clean: build?.sourceClean === true,
      platform: Platform.OS,
      os_version: Platform.Version,
      launchId,
      values: details,
    },
    ...(commandId ? { commandId } : {}),
    ...(status ? { status } : {}),
  });
}

export function NativeAcceptanceController(): React.JSX.Element {
  const theme = useTheme();
  const account = useAuthenticatedAccount();
  const queryClient = useQueryClient();
  const accountRef = useRef(account);
  accountRef.current = account;
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [toolCount, setToolCount] = useState(0);
  const [status, setStatus] = useState("Starting native acceptance");
  const sessions = useRef(new Map<string, SessionTransport>());
  const owners = useRef(new Map<string, boolean>());
  const tools = useRef(new Map<number, HostTransport>());
  const uploads = useRef(new Map<string, Record<string, unknown>>());
  const registeredDeviceId = useRef<string | null>(null);
  const mounted = useRef<string[]>([]);
  mounted.current = selection;
  const selectedTools = useRef(0);
  selectedTools.current = toolCount;

  useEffect(() => {
    let stopped = false;
    let current: Bootstrap;
    const snapshot = () => ({
      appState: AppState.currentState,
      nativeDateMs: Date.now(),
      accountReady: accountRef.current.ready,
      accountId: accountRef.current.accountId,
      identityGeneration: deviceIdentityGeneration(),
      deviceId:
        accountRef.current.accountId === current?.accountId ? registeredDeviceId.current : null,
      sessions: Object.fromEntries(
        mounted.current.map((key) => [
          key,
          {
            sessionId: sessions.current.get(key)?.sessionId,
            state: sessions.current.get(key)?.state ?? "unmounted",
            daemonState: sessions.current.get(key)?.daemonState ?? "idle",
            owner:
              sessions.current.get(key)?.state === "ready" && (owners.current.get(key) ?? false),
          },
        ]),
      ),
      tools: Array.from({ length: selectedTools.current }, (_, index) => ({
        index,
        state: tools.current.get(index)?.state ?? "unmounted",
      })),
      peer: probes.get(current?.hostId)?.snapshot ?? null,
      peerAgeMs: probes.has(current?.hostId)
        ? Date.now() - (probes.get(current.hostId)?.receivedAt ?? 0)
        : null,
      uploads: Object.fromEntries(uploads.current),
    });
    const register = async () => {
      setDeviceIdentityAccount(current.accountId);
      const registered = await ensureDeviceRegistered({
        accountId: current.accountId,
        label: "Native acceptance",
      });
      const identity = await deviceIdentity.ensure();
      // Endorsements and revocation target the server row, whose UUID is
      // independent of the deterministic local key ID.
      registeredDeviceId.current = registered.id;
      const publicKey = encodeBase64Url(identity.publicKey);
      await control("/__acceptance/device", { deviceId: registered.id, publicKey });
      await event("identity", {
        deviceId: registered.id,
        publicKey,
        generation: deviceIdentityGeneration(),
      });
    };
    const authenticate = async (next: { accountId: string; bearerToken: string }) => {
      await authToken.set(next.bearerToken);
      const me = await getMe();
      if (me.user.id !== next.accountId) throw new Error("Fixture login returned another account.");
      adoptAuthenticatedAccount(queryClient, me.user);
    };
    const perform = async ({ action, payload = {} }: Command): Promise<unknown> => {
      const key = payload["session"] === "b" ? "b" : "a";
      switch (action) {
        case "mount": {
          if (!accountRef.current.ready) throw new Error("Authenticated app is not ready.");
          const wanted = Array.isArray(payload["sessions"]) ? payload["sessions"] : ["a", "b"];
          if (
            wanted.some((id) => id !== "a" && id !== "b") ||
            new Set(wanted).size !== wanted.length
          )
            throw new Error("Only fixture sessions a and b are allowed.");
          const count = Number(payload["tools"] ?? 2);
          if (!Number.isInteger(count) || count < 0 || count > 2)
            throw new Error("Invalid tool count.");
          setSelection(wanted as string[]);
          setToolCount(count);
          await until(
            () =>
              mounted.current.length === wanted.length &&
              mounted.current.every((id, index) => id === wanted[index]) &&
              selectedTools.current === count &&
              wanted.every((id) => sessions.current.get(String(id))?.state === "ready") &&
              Array.from(
                { length: count },
                (_, i) => tools.current.get(i)?.state === "ready",
              ).every(Boolean),
            "Native session/tool attachment did not become ready.",
          );
          return snapshot();
        }
        case "unmount":
          setSelection([]);
          setToolCount(0);
          await until(
            () => mounted.current.length === 0 && selectedTools.current === 0,
            "Views did not unmount.",
          );
          await wait(300);
          return snapshot();
        case "snapshot":
          return snapshot();
        case "retry-host": {
          const lease = retainHostTransport({
            hostId: current.hostId,
            hostIdentityPublicKey: current.hostPublicKey,
          });
          const root = lease.shared.transport;
          try {
            root.close();
            await root.open();
            return { opened: true, state: root.state };
          } catch (error) {
            return { opened: false, state: root.state, error: String(error) };
          } finally {
            lease.release();
          }
        }
        case "input": {
          const session = sessions.current.get(key);
          if (!session || !mounted.current.includes(key))
            throw new Error("Session is not mounted.");
          const text = payload["text"];
          if (typeof text !== "string" || text.length > 4096)
            throw new Error("Invalid fixture input.");
          if (payload["takeControl"] === true) {
            await until(() => session.state === "ready", "Session is not ready for control.");
            owners.current.set(key, false);
            session.takeControl();
            await until(
              () => owners.current.get(key) === true,
              "Daemon did not confirm input control.",
            );
          }
          session.write(new TextEncoder().encode(text));
          return {
            session: key,
            bytes: new TextEncoder().encode(text).length,
            state: session.state,
            owner: owners.current.get(key),
          };
        }
        case "host-request": {
          const operation = payload["operation"] ?? "fs.home";
          if (operation !== "fs.home" && operation !== "fs.list")
            throw new Error("Unsupported fixture host operation.");
          const tool = tools.current.get(Number(payload["tool"] ?? 0));
          if (!tool) throw new Error("Host tool is not mounted.");
          return await tool.request(operation, payload["payload"]);
        }
        case "upload": {
          const session = sessions.current.get(key);
          if (session?.state !== "ready") throw new Error("Upload session is not ready.");
          const totalBytes = Number(payload["totalBytes"] ?? 8 * 1024 * 1024);
          if (!Number.isInteger(totalBytes) || totalBytes < 1 || totalBytes > 20 * 1024 * 1024)
            throw new Error("Invalid upload size.");
          const bytes = new Uint8Array(totalBytes).fill(0x61);
          const digest = encodeHex(sha256(bytes));
          const uploadId = String(payload["uploadId"] ?? "");
          const name = String(payload["name"] ?? "native-acceptance.txt");
          if (!/^[0-9a-f-]{36}$/.test(uploadId) || !/^[a-zA-Z0-9._-]+$/.test(name))
            throw new Error("Invalid fixture upload identity.");
          const delay = Math.min(100, Math.max(0, Number(payload["readDelayMs"] ?? 15)));
          const handle = session.upload({
            uploadId,
            name,
            mimeType: "text/plain",
            destination: "cwd",
            totalBytes,
            sha256: digest,
            source: {
              size: totalBytes,
              read: async (offset, length) => {
                await wait(delay);
                return bytes.slice(offset, offset + length);
              },
            },
            beforeFinalDispatch: async () => {
              await event("upload-final-dispatch", { uploadId });
            },
          });
          uploads.current.set(uploadId, {
            state: handle.state,
            totalBytes,
            sentBytes: 0,
            sha256: digest,
          });
          handle.onProgress((progress: UploadProgress) => {
            uploads.current.set(uploadId, { ...progress, sha256: digest });
            void event("upload", progress).catch(() => {});
          });
          void handle.result
            .then(
              (result) => {
                uploads.current.set(uploadId, {
                  ...result,
                  state: "complete",
                  sentBytes: totalBytes,
                });
                return event("upload", { ...result, state: "complete" });
              },
              (error: unknown) => {
                uploads.current.set(uploadId, {
                  ...uploads.current.get(uploadId),
                  resultError: String(error),
                });
                return event("upload", { uploadId, error: String(error) });
              },
            )
            .catch(() => {});
          return { uploadId, totalBytes, sha256: digest };
        }
        case "upload-status":
          return uploads.current.get(String(payload["uploadId"])) ?? null;
        case "rotate-identity": {
          const previous = [...mounted.current];
          const previousTools = selectedTools.current;
          setSelection([]);
          setToolCount(0);
          await until(
            () => mounted.current.length === 0 && selectedTools.current === 0,
            "Views did not detach before identity replacement.",
          );
          // The authenticated provider still retains the old parent. Reset
          // retires that live ownership; request new children after approval.
          await deviceIdentity.reset();
          await register();
          setSelection(previous);
          setToolCount(previousTools);
          return snapshot();
        }
        case "sign-out":
          await logOut();
          await until(() => !accountRef.current.ready, "Account did not retire.");
          return snapshot();
        case "switch-account": {
          if (payload["account"] !== "a" && payload["account"] !== "b")
            throw new Error("Only fixture accounts a and b are allowed.");
          await logOut();
          await until(() => !accountRef.current.ready, "Previous account did not retire.");
          current = await control<Bootstrap>("/__acceptance/bootstrap");
          if (current.candidateCommit !== build?.candidateCommit)
            throw new Error("Fixture candidate differs from the embedded native candidate.");
          const next = payload["account"] === "b" ? current.secondAccount : current;
          await authenticate(next);
          await until(
            () => accountRef.current.ready && accountRef.current.accountId === next.accountId,
            "Replacement account did not initialize.",
          );
          if (payload["account"] === "a") await register();
          setBootstrap(current);
          return snapshot();
        }
        case "sign-in":
          current = await control<Bootstrap>("/__acceptance/bootstrap");
          if (current.candidateCommit !== build?.candidateCommit)
            throw new Error("Fixture candidate differs from the embedded native candidate.");
          await authenticate(current);
          await until(() => accountRef.current.ready, "Account did not initialize.");
          await register();
          setBootstrap(current);
          return snapshot();
        default:
          throw new Error(`Unknown native acceptance command: ${action}`);
      }
    };
    const lifecycle = AppState.addEventListener("change", (state) => {
      void event("app-state", { state, nativeDateMs: Date.now() }).catch(() => {});
    });
    void (async () => {
      try {
        current = await control<Bootstrap>("/__acceptance/bootstrap");
        if (current.candidateCommit !== build?.candidateCommit)
          throw new Error("Fixture candidate differs from the embedded native candidate.");
        await authenticate(current);
        await until(() => accountRef.current.ready, "Authenticated app did not initialize.");
        await register();
        if (stopped) return;
        setBootstrap(current);
        setStatus("Native acceptance ready");
        await event("boot", { runId: current.runId, snapshot: snapshot() }, undefined, "passed");
        while (!stopped) {
          if (AppState.currentState !== "active") {
            await wait(250);
            continue;
          }
          let command: Command | null;
          try {
            command = await control<Command | null>("/__acceptance/command");
          } catch {
            await wait(500);
            continue;
          }
          if (!command) {
            await wait(250);
            continue;
          }
          try {
            setStatus(command.action);
            const result = await perform(command);
            await event("command", { action: command.action, result }, command.id, "passed");
          } catch (error) {
            await event(
              "command",
              { action: command.action, error: String(error), snapshot: snapshot() },
              command.id,
              "failed",
            );
          }
        }
      } catch (error) {
        setStatus(String(error));
        await event(
          "boot",
          { error: String(error), snapshot: snapshot() },
          undefined,
          "failed",
        ).catch(() => {});
      }
    })();
    return () => {
      stopped = true;
      lifecycle.remove();
    };
  }, [queryClient]);

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: theme.colors.background }]}
    >
      <Text
        style={{ color: theme.colors.foreground }}
        accessibilityLabel="Native acceptance status"
      >
        {status}
      </Text>
      {bootstrap &&
        account.ready &&
        account.accountId === bootstrap.accountId &&
        selection.map((key) => (
          <TerminalSurface
            key={key}
            hostId={bootstrap.hostId}
            hostIdentityPublicKey={bootstrap.hostPublicKey}
            sessionId={key === "a" ? bootstrap.sessionA : bootstrap.sessionB}
            initialSize={{ cols: 80, rows: 24 }}
            style={styles.terminal}
            onTransport={(transport) => sessions.current.set(key, transport)}
            onDisplayChange={(display) => owners.current.set(key, display.owner)}
            onStateChange={(state) => {
              if (state !== "ready") owners.current.set(key, false);
              void event("transport", { session: key, state }).catch(() => {});
            }}
            onError={(error) => {
              void event("transport-error", { session: key, ...error }).catch(() => {});
            }}
          />
        ))}
      {bootstrap &&
        account.ready &&
        account.accountId === bootstrap.accountId &&
        [0, 1]
          .slice(0, toolCount)
          .map((index) => (
            <HostTransportSurface
              key={index}
              hostId={bootstrap.hostId}
              hostIdentityPublicKey={bootstrap.hostPublicKey}
              onTransport={(transport) => tools.current.set(index, transport)}
            />
          ))}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { zIndex: 50, paddingTop: spacing[12] },
  terminal: { flex: 1 },
});
