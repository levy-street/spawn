import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./styles.css";

type Screen =
  | "welcome"
  | "auth"
  | "device"
  | "server"
  | "possess"
  | "done"
  | "settings"
  | "repair"
  | "quit";

interface Preferences {
  server_origin: string;
  account_id: string | null;
  account_email: string | null;
  device_id: string | null;
  device_approved: boolean;
  first_run_complete: boolean;
  host_name: string | null;
}

interface AuthOutcome {
  account_id: string;
  email: string;
  device_id: string;
  approval_required: boolean;
}

type DeviceProgress =
  | { state: "waiting" }
  | { state: "show_number"; pairing_id: string; number: string }
  | { state: "approved" }
  | { state: "refused"; message: string };

interface ApprovalReview {
  approval_ref: string;
  host_name: string;
  host_public_key: string;
  fingerprint: string;
  local_fingerprint: string | null;
  exact_key_match: boolean;
  needs_fingerprint_compare: boolean;
}

interface PossessionProgress {
  claim_token: string;
  claim: {
    status: "pending" | "ready" | "approved" | "failed";
    host_name: string | null;
    error: string | null;
  };
  review: ApprovalReview | null;
  child_finished: boolean;
  child_error: string | null;
}

interface LocalStatus {
  status: Record<string, unknown>;
  doctor: Record<string, unknown> | null;
  heartbeat: { connected: boolean; sessions: number; last_error: unknown } | null;
  launchctl: string;
  hosts: unknown;
  release: unknown;
  log_tail: string;
}

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("SPAWN D window root is unavailable");
const app: HTMLDivElement = root;

let preferences: Preferences = {
  server_origin: "https://spawnd.dev",
  account_id: null,
  account_email: null,
  device_id: null,
  device_approved: false,
  first_run_complete: false,
  host_name: null,
};
let screen: Screen = "welcome";
let authMode: "login" | "signup" = "login";
let serverChoice: "hosted" | "self" = "hosted";
let error: string | null = null;
let busy = false;
let deviceProgress: DeviceProgress = { state: "waiting" };
let devicePoll: number | null = null;
let claimToken: string | null = null;
let possession: PossessionProgress | null = null;
let possessionPoll: number | null = null;
const completedSteps = new Set<number>();
let terminalCommand = "curl -fsSL https://spawnd.dev/install.sh | sh";
let status: LocalStatus | null = null;
let statusLoading = false;
let appUpdate: { available: boolean; version: string | null; endpoint: string } | null = null;

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function shell(content: string, step?: string): string {
  return `
    <div class="shell">
      <header class="mast">
        <div class="brand"><span class="brand-mark">◉</span> SPAWN D</div>
        <div class="step">${escapeHtml(step ?? "DESKTOP COMPANION")}</div>
      </header>
      <main class="stage">${content}</main>
      <footer class="foot"><span>LOCAL CLIENT · SIGNED UPDATE CHANNEL</span><span>${escapeHtml(preferences.server_origin)}</span></footer>
    </div>`;
}

function message(): string {
  return error ? `<div class="message" role="alert">${escapeHtml(error)}</div>` : "";
}

function render(): void {
  const content =
    screen === "welcome"
      ? welcomeView()
      : screen === "auth"
        ? authView()
        : screen === "device"
          ? deviceView()
          : screen === "server"
            ? serverView()
            : screen === "possess"
              ? possessView()
              : screen === "done"
                ? doneView()
                : screen === "settings"
                  ? settingsView()
                  : screen === "repair"
                    ? repairView()
                    : quitView();
  app.innerHTML = shell(content, progressLabel());
  bindActions();
}

function progressLabel(): string {
  const labels: Record<Screen, string> = {
    welcome: "01 · WELCOME",
    auth: "02 · IDENTITY",
    device: "03 · NUMBER CHECK",
    server: "04 · CONTROL PLANE",
    possess: "05 · THIS MAC",
    done: "READY",
    settings: "SETTINGS",
    repair: "REPAIR",
    quit: "QUIT",
  };
  return labels[screen];
}

function welcomeView(): string {
  return `
    <section class="welcome-grid">
      <div class="sigil" aria-hidden="true"><span>SP</span><i>D</i></div>
      <div class="copy-stack">
        <p class="eyebrow">FIRST POSSESSION</p>
        <h1>Possess this Mac.</h1>
        <p class="lead">Sign in, pick your server, and SPAWN D does the rest — the daemon installed, verified, and kept running. About two minutes.</p>
        ${message()}
        <div class="actions"><button class="primary" data-action="get-started">Get started</button></div>
        <details class="installed"><summary>What gets installed?</summary><p>Two binaries in <code>~/.local/bin</code>, one LaunchAgent, nothing else.</p></details>
      </div>
    </section>`;
}

function authView(): string {
  const signup = authMode === "signup";
  return `
    <section class="narrow">
      <p class="eyebrow">IDENTITY IS A DEVICE</p>
      <h1>Who summons?</h1>
      <p class="lead compact">${signup ? "Create the account that will possess this Mac." : "Sign in and this app becomes a revocable device on your account."}</p>
      <form id="auth-form" class="form-stack">
        <label>Email<input name="email" type="email" autocomplete="email" required /></label>
        <label>Password<input name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? "8" : "1"}" ${signup ? 'maxlength="256"' : ""} required /></label>
        ${signup ? '<label>Invite <span>(if your server requires one)</span><input name="invite" type="text" autocomplete="off" maxlength="256" /></label>' : ""}
        ${message()}
        <button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Contacting your server…" : signup ? "Create account" : "Sign in"}</button>
      </form>
      <div class="rule"><span>OR</span></div>
      <div class="providers">
        ${["Google", "GitHub", "Microsoft", "Apple"]
          .map(
            (provider) =>
              `<button class="secondary" data-provider="${provider.toLowerCase()}" ${busy ? "disabled" : ""}>Continue with ${provider}<span>↗</span></button>`,
          )
          .join("")}
      </div>
      <div class="auth-links">
        <button class="text-button" data-action="toggle-auth">${signup ? "Already have an account? Sign in" : "Create an account"}</button>
        <button class="text-button server-link" data-action="preauth-server">Using ${escapeHtml(preferences.server_origin)} · Change</button>
      </div>
    </section>`;
}

function deviceView(): string {
  const number = deviceProgress.state === "show_number" ? deviceProgress.number : null;
  const refused = deviceProgress.state === "refused" ? deviceProgress.message : null;
  return `
    <section class="narrow waiting">
      <p class="eyebrow">DEVICE APPROVAL</p>
      <h1>Approve this device</h1>
      <p class="lead compact">Approve from a device you already use.</p>
      <div class="number-card ${number ? "ready" : ""}">
        <span>${number ? "TYPE THIS NUMBER THERE" : "WAITING FOR AN APPROVING DEVICE"}</span>
        <strong>${escapeHtml(number ?? "·· ··")}</strong>
        <p>${number ? "The number proves both screens saw the same two device keys." : "A knock is waiting on your other signed-in devices."}</p>
      </div>
      ${refused ? `<div class="message" role="alert">${escapeHtml(refused)}</div>` : message()}
      <button class="secondary" data-action="ask-again" ${busy ? "disabled" : ""}>Ask again</button>
      <p class="fine">This check is never skippable. No device key is trusted until the number matches.</p>
    </section>`;
}

function serverView(): string {
  return `
    <section class="narrow">
      <p class="eyebrow">CONTROL PLANE</p>
      <h1>Whose altar?</h1>
      <p class="lead compact">Choose the server this app and the daemon answer to.</p>
      <form id="server-form" class="server-options">
        <label class="server-option ${serverChoice === "hosted" ? "selected" : ""}">
          <input type="radio" name="server-kind" value="hosted" ${serverChoice === "hosted" ? "checked" : ""} />
          <span><strong>spawnd.dev</strong><small>Hosted. Fastest start.</small></span>
        </label>
        <label class="server-option ${serverChoice === "self" ? "selected" : ""}">
          <input type="radio" name="server-kind" value="self" ${serverChoice === "self" ? "checked" : ""} />
          <span><strong>A server you run</strong><small>Self-hosting is the strongest trust stance — the server only ever relays.</small></span>
        </label>
        ${
          serverChoice === "self"
            ? `<label class="advanced">Server URL<input name="server-url" type="url" value="${escapeHtml(preferences.server_origin === "https://spawnd.dev" ? "" : preferences.server_origin)}" placeholder="Enter a SPAWN D server URL" required /></label>`
            : ""
        }
        ${message()}
        <button class="primary" type="submit" ${busy ? "disabled" : ""}>Continue</button>
      </form>
    </section>`;
}

const steps = [
  "Downloading the daemon",
  "Verifying — hashes match the server's manifest",
  "Starting the service",
  "Registering this Mac",
  "Approved — key verified on this machine",
];

function possessView(): string {
  const review = possession?.review;
  const failed = possession?.claim.status === "failed";
  const keyMismatch = error === "This host could not be verified.";
  const serviceFailed = error === "The daemon installed but its service didn't start.";
  const alreadyPossessed = error?.includes("already possessed for") ?? false;
  return `
    <section class="narrow possess">
      <p class="eyebrow">LOCAL INSTALL</p>
      <h1>Possess this Mac.</h1>
      <p class="lead compact">Both binaries come from ${escapeHtml(preferences.server_origin)} and are checked before installation.</p>
      <ol class="progress-list">
        ${steps
          .map(
            (step, index) => `<li class="${completedSteps.has(index) ? "complete" : claimToken && index === Math.min(completedSteps.size, 4) ? "active" : ""}"><span>${completedSteps.has(index) ? "✓" : String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(step)}</p></li>`,
          )
          .join("")}
      </ol>
      ${
        review
          ? approvalReview(review)
          : !claimToken
            ? `<button class="primary possess-button" data-action="possess" ${busy ? "disabled" : ""}>Possess this Mac</button>`
            : '<div class="inline-wait"><span class="spinner"></span> The daemon is preparing its identity…</div>'
      }
      ${failed ? `<div class="message" role="alert">${escapeHtml(claimErrorCopy(possession?.claim.error))}</div>` : message()}
      ${
        error
          ? keyMismatch
            ? '<div class="fallback-actions"><button class="text-button" data-action="learn-key-check">Learn what this means</button></div>'
            : serviceFailed
              ? '<div class="fallback-actions"><button class="secondary" data-action="show-repair">Repair</button></div>'
              : alreadyPossessed
                ? '<div class="fallback-actions"><button class="secondary" data-action="open-browser">Open SPAWN D</button></div>'
                : '<div class="fallback-actions"><button class="secondary" data-action="try-again">Try again</button><button class="text-button" data-action="terminal">Use the Terminal instead</button></div>'
          : ""
      }
      <div class="command-chip"><span>$</span><code>${escapeHtml(terminalCommand)}</code><button data-action="copy-command" aria-label="Copy installer">COPY</button></div>
    </section>`;
}

function claimErrorCopy(reason: string | null | undefined): string {
  if (reason === "expired") return "That code expired. On the machine, run spawnd possess again.";
  if (reason === "denied") return "Possession was denied. Nothing was changed.";
  if (reason === "key_conflict")
    return "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.\n• To use it under that account: sign in there and approve as usual.\n• To hand it to this account: remove the host from the old account's Hosts page first, then run spawnd possess again.\n• To keep both accounts on this machine: spawnd possess --new-account";
  if (reason === "pin_conflict")
    return "The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.";
  if (reason === "pin_limit")
    return "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.";
  return "Possession failed. Nothing was changed.";
}

function approvalReview(review: ApprovalReview): string {
  if (review.exact_key_match) {
    return `
      <div class="approval-review verified">
        <div><span>LOCAL PIPE CHECK</span><strong>Exact key match</strong></div>
        <code>${escapeHtml(review.fingerprint)}</code>
        <button class="primary" data-action="approve-host" ${busy ? "disabled" : ""}>Possess this Mac</button>
      </div>`;
  }
  return `
    <div class="approval-review">
      <div><span>FULL FINGERPRINT CHECK</span><strong>Compare both lines</strong></div>
      <dl><dt>From the daemon</dt><dd>${escapeHtml(review.local_fingerprint ?? "Not printed")}</dd><dt>From the server</dt><dd>${escapeHtml(review.fingerprint)}</dd></dl>
      <button class="primary" data-action="approve-fingerprint" ${review.local_fingerprint !== review.fingerprint || busy ? "disabled" : ""}>They match — possess this Mac</button>
    </div>`;
}

function doneView(): string {
  const host = possession?.claim.host_name ?? preferences.host_name ?? "This Mac";
  return `
    <section class="done-grid">
      <div class="done-mark" aria-hidden="true">✓</div>
      <div>
        <p class="eyebrow">POSSESSION COMPLETE</p>
        <h1>${escapeHtml(host)} is possessed.</h1>
        <p class="lead">All your devices can reach it. SPAWN D lives in your menu bar; the daemon keeps running on its own.</p>
        ${message()}
        <div class="actions"><button class="primary" data-action="open-browser">Open SPAWN D</button><button class="secondary" data-action="done">Done</button></div>
      </div>
    </section>`;
}

function settingsView(): string {
  const instances = status?.status.instances;
  const instance = Array.isArray(instances) ? instances[0] : null;
  const connected = status?.heartbeat?.connected ?? false;
  return `
    <section class="wide">
      <div class="section-head"><div><p class="eyebrow">MENU BAR COMPANION</p><h1>Settings</h1></div><button class="close" data-action="close-window" aria-label="Close">×</button></div>
      <div class="status-band"><span class="status-dot ${connected ? "online" : ""}"></span><div><strong>${connected ? "Possessed, online" : "Checking this Mac"}</strong><small>${escapeHtml(preferences.host_name ?? "This Mac")} · ${escapeHtml(preferences.server_origin)}</small></div></div>
      <div class="settings-list">
        <button data-action="open-browser"><span><strong>Open SPAWN D</strong><small>Continue in your system browser</small></span><b>↗</b></button>
        <button data-action="show-repair"><span><strong>Repair…</strong><small>Run the daemon's own recovery path</small></span><b>›</b></button>
        <button data-action="check-update"><span><strong>Update SPAWN D…</strong><small>${appUpdate?.available ? `Version ${escapeHtml(appUpdate.version)} is ready` : "Check the independently signed app channel"}</small></span><b>${appUpdate?.available ? "↓" : "↻"}</b></button>
        <button class="danger" data-action="confirm-stop"><span><strong>Stop possessing this Mac…</strong><small>Runs spawnd exorcise --yes after confirmation</small></span><b>—</b></button>
      </div>
      ${message()}
      <details class="diagnostics"><summary>Daemon details</summary><pre>${escapeHtml(JSON.stringify(instance ?? status?.status ?? {}, null, 2))}</pre></details>
    </section>`;
}

function repairView(): string {
  return `
    <section class="wide">
      <div class="section-head"><div><p class="eyebrow">DELEGATED RECOVERY</p><h1>Repair</h1></div><button class="close" data-action="settings">×</button></div>
      <p class="lead compact">SPAWN D asks the daemon to repair itself first. Reinstall remains available only if that does not work.</p>
      <div class="repair-order">
        <button class="primary" data-action="repair-resume" ${busy ? "disabled" : ""}>1 · Re-run spawnd possess</button>
        <button class="secondary" data-action="repair-reinstall" ${busy ? "disabled" : ""}>2 · Verified reinstall</button>
      </div>
      ${message()}
      <div class="log-head"><span>RECENT DAEMON LOGS</span><button class="text-button" data-action="copy-logs">Copy</button></div>
      <pre class="logs">${escapeHtml(status?.log_tail || "No daemon log lines are available yet.")}</pre>
    </section>`;
}

function quitView(): string {
  return `
    <section class="narrow quit-view">
      <p class="eyebrow">LEAVE THE COMPANION</p>
      <h1>Quit SPAWN D?</h1>
      <p class="lead">The daemon keeps running while SPAWN D is closed.</p>
      <div class="actions"><button class="primary" data-action="quit-app">Quit SPAWN D</button><button class="secondary" data-action="settings">Cancel</button></div>
    </section>`;
}

function bindActions(): void {
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
    element.addEventListener("click", () => void act(element.dataset.action ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-provider]").forEach((element) => {
    element.addEventListener("click", () => void beginOAuth(element.dataset.provider ?? ""));
  });
  document.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAuth(new FormData(event.currentTarget as HTMLFormElement));
  });
  document.querySelectorAll<HTMLInputElement>('input[name="server-kind"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      serverChoice = radio.value === "self" ? "self" : "hosted";
      render();
    });
  });
  document.querySelector<HTMLFormElement>("#server-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitServer(new FormData(event.currentTarget as HTMLFormElement));
  });
}

async function act(action: string): Promise<void> {
  error = null;
  if (action === "get-started") setScreen("auth");
  else if (action === "toggle-auth") {
    authMode = authMode === "login" ? "signup" : "login";
    render();
  } else if (action === "preauth-server") {
    serverChoice = preferences.server_origin === "https://spawnd.dev" ? "hosted" : "self";
    setScreen("server");
  } else if (action === "ask-again") await guarded(async () => invoke("ask_for_device_approval"));
  else if (action === "possess" || action === "repair-reinstall") await startPossession();
  else if (action === "try-again") {
    claimToken = null;
    possession = null;
    completedSteps.clear();
    render();
  } else if (action === "approve-host") await approveHost(false);
  else if (action === "approve-fingerprint") await approveHost(true);
  else if (action === "terminal") await navigator.clipboard.writeText(terminalCommand);
  else if (action === "learn-key-check")
    await openUrl("https://spawnd.dev/docs/trust#possess-a-host");
  else if (action === "copy-command") await navigator.clipboard.writeText(terminalCommand);
  else if (action === "open-browser") await openUrl(preferences.server_origin);
  else if (action === "done" || action === "close-window") window.close();
  else if (action === "settings") {
    setScreen("settings");
    await refreshStatus(false);
  } else if (action === "show-repair") {
    setScreen("repair");
    await refreshStatus(true);
  } else if (action === "repair-resume") {
    await guarded(async () => invoke<string>("repair_resume"));
    await refreshStatus(true);
  } else if (action === "copy-logs") await navigator.clipboard.writeText(status?.log_tail ?? "");
  else if (action === "check-update") await checkUpdate(true);
  else if (action === "confirm-stop") {
    if (window.confirm("Stop possessing this Mac? This removes the daemon service and local registration.")) {
      await guarded(async () => invoke<string>("stop_possessing"));
      await refreshStatus(true);
    }
  } else if (action === "quit-app") await invoke("quit_app");
}

function setScreen(next: Screen): void {
  screen = next;
  error = null;
  render();
}

async function guarded<T>(operation: () => Promise<T>): Promise<T | null> {
  busy = true;
  error = null;
  render();
  try {
    return await operation();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    return null;
  } finally {
    busy = false;
    render();
  }
}

async function submitAuth(data: FormData): Promise<void> {
  const email = String(data.get("email") ?? "");
  const password = String(data.get("password") ?? "");
  const invite = String(data.get("invite") ?? "").trim() || null;
  const result = await guarded(() =>
    invoke<AuthOutcome>(authMode === "signup" ? "password_signup" : "password_login", {
      origin: preferences.server_origin,
      email,
      password,
      invite,
    }),
  );
  if (result) await finishAuth(result);
}

async function beginOAuth(provider: string): Promise<void> {
  const url = await guarded(() =>
    invoke<string>("oauth_start_url", {
      origin: preferences.server_origin,
      provider,
      invite: null,
    }),
  );
  if (url) await openUrl(url);
}

async function handleDeepLink(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "spawn:" || url.hostname !== "oauth" || url.pathname !== "/callback") return;
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    error = oauthError;
    render();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) return;
  const result = await guarded(() =>
    invoke<AuthOutcome>("exchange_oauth_code", { origin: preferences.server_origin, code }),
  );
  if (result) await finishAuth(result);
}

async function finishAuth(result: AuthOutcome): Promise<void> {
  preferences = await invoke<Preferences>("app_preferences");
  if (result.approval_required) {
    setScreen("device");
    startDevicePoll();
  } else {
    setScreen("server");
  }
}

function startDevicePoll(): void {
  if (devicePoll !== null) window.clearInterval(devicePoll);
  const poll = async (): Promise<void> => {
    try {
      deviceProgress = await invoke<DeviceProgress>("poll_device_approval");
      if (deviceProgress.state === "approved") {
        if (devicePoll !== null) window.clearInterval(devicePoll);
        devicePoll = null;
        preferences = await invoke<Preferences>("app_preferences");
        setScreen("server");
        return;
      }
      render();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      render();
    }
  };
  void poll();
  devicePoll = window.setInterval(() => void poll(), 1500);
}

async function submitServer(data: FormData): Promise<void> {
  const origin =
    serverChoice === "hosted" ? "https://spawnd.dev" : String(data.get("server-url") ?? "");
  if (origin !== preferences.server_origin && preferences.account_id) {
    await invoke("sign_out");
  }
  const normalized = await guarded(() => invoke<string>("choose_server", { serverUrl: origin }));
  if (!normalized) return;
  preferences = await invoke<Preferences>("app_preferences");
  terminalCommand = await invoke<string>("terminal_install_command");
  if (!preferences.account_id) setScreen("auth");
  else setScreen("possess");
}

async function startPossession(): Promise<void> {
  const token = await guarded(() => invoke<string>("begin_possession"));
  if (!token) return;
  claimToken = token;
  possession = null;
  setScreen("possess");
  startPossessionPoll();
}

function startPossessionPoll(): void {
  if (possessionPoll !== null) window.clearInterval(possessionPoll);
  const poll = async (): Promise<void> => {
    if (!claimToken) return;
    try {
      possession = await invoke<PossessionProgress>("poll_possession", { claimToken });
      if (possession.claim.status === "approved") {
        if (possessionPoll !== null) window.clearInterval(possessionPoll);
        possessionPoll = null;
        preferences = await invoke<Preferences>("app_preferences");
        setScreen("done");
        return;
      }
      if (possession.child_error) {
        error = possession.child_error;
      }
      render();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      if (error.includes("This host could not be verified")) {
        error = "This host could not be verified.";
      }
      render();
    }
  };
  void poll();
  possessionPoll = window.setInterval(() => void poll(), 1500);
}

async function approveHost(fingerprintConfirmed: boolean): Promise<void> {
  if (!claimToken) return;
  const result = await guarded(() =>
    invoke<string>("approve_possession", { claimToken, fingerprintConfirmed }),
  );
  if (result) completedSteps.add(4);
}

async function refreshStatus(includeDoctor: boolean): Promise<void> {
  if (statusLoading) return;
  statusLoading = true;
  try {
    status = await invoke<LocalStatus>("local_status", { includeDoctor });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    statusLoading = false;
    render();
  }
}

async function checkUpdate(prompt: boolean): Promise<void> {
  const result = await guarded(() =>
    invoke<{ available: boolean; version: string | null; endpoint: string }>("check_app_update"),
  );
  if (!result) return;
  appUpdate = result;
  if (
    prompt &&
    result.available &&
    window.confirm(`Install SPAWN D ${result.version ?? "update"} now?`)
  ) {
    await guarded(() => invoke<boolean>("install_app_update"));
  }
  render();
}

async function initialize(): Promise<void> {
  preferences = await invoke<Preferences>("app_preferences");
  terminalCommand = await invoke<string>("terminal_install_command");
  screen = preferences.first_run_complete ? "settings" : "welcome";
  serverChoice = preferences.server_origin === "https://spawnd.dev" ? "hosted" : "self";
  await listen<{ index: number }>("possess-step", (event) => {
    completedSteps.add(event.payload.index);
    render();
  });
  await listen<string>("tray-surface", (event) => {
    screen = event.payload === "repair" ? "repair" : event.payload === "quit" ? "quit" : "settings";
    render();
    void refreshStatus(screen === "repair");
    if (event.payload === "update") void checkUpdate(true);
  });
  await listen("tray-open-browser", () => void openUrl(preferences.server_origin));
  await onOpenUrl((urls) => {
    for (const url of urls) void handleDeepLink(url);
  });
  for (const url of (await getCurrent()) ?? []) void handleDeepLink(url);
  render();
  if (preferences.first_run_complete) await refreshStatus(false);
  if (preferences.first_run_complete) void checkUpdate(false);
  window.setInterval(() => {
    if (preferences.first_run_complete) void refreshStatus(false);
  }, 15_000);
  window.setInterval(() => {
    if (preferences.account_id) void invoke("renew_session").catch(() => undefined);
  }, 12 * 60 * 60_000);
}

void initialize().catch((cause) => {
  error = cause instanceof Error ? cause.message : String(cause);
  render();
});
