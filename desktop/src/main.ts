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
  host_name: string;
  exact_key_match: boolean;
}

interface PossessionProgress {
  run_id: string;
  status: "starting" | "registered" | "approved" | "online" | "failed";
  error: string | null;
  host_name: string | null;
  host_id: string | null;
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
let runId: string | null = null;
let possession: PossessionProgress | null = null;
let possessionPoll: number | null = null;
const completedSteps = new Set<number>();
let terminalCommand = "curl -fsSL https://spawnd.dev/install.sh | sh";
let status: LocalStatus | null = null;
let statusLoading = false;
let appUpdate: { available: boolean; version: string | null; endpoint: string } | null = null;
/* The device gate is only walked when the account already has an approving
 * device, so the rail below the masthead names it only on runs that need it —
 * the same "gates this account actually has to pass" rule the web funnel
 * follows rather than showing a step that will never light. */
let deviceGateRequired = false;

/** The chosen server's host, for the places a full origin would not fit. */
function serverHost(): string {
  try {
    return new URL(preferences.server_origin).host;
  } catch {
    return preferences.server_origin;
  }
}

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

/**
 * The brand lockup: the trident art in hellfire with the drawn wordmark beside
 * it, the same pair every web surface wears. The wordmark is a mask filled
 * with `currentColor`, so it takes the lockup's ink rather than carrying its
 * own.
 */
const LOCKUP = '<div class="lockup"><span class="trident" aria-hidden="true"></span><span class="wordmark" role="img" aria-label="spawnd"></span></div>';

/** The corners of the press bed, struck in hellfire. */
const REGISTRATION_MARKS =
  '<span class="marks" aria-hidden="true"><span>+</span><span>+</span><span>+</span><span>+</span></span>';

function shell(content: string, step: string): string {
  return `
    <div class="shell">
      <div class="mast-block">
        <header class="mast">
          ${LOCKUP}
          <div class="step">${escapeHtml(step)}</div>
        </header>
        ${gateRail()}
      </div>
      <main class="stage">${REGISTRATION_MARKS}${content}</main>
      <footer class="foot"><span>Local client · Signed update channel</span><span class="origin">${escapeHtml(preferences.server_origin)}</span></footer>
    </div>`;
}

/**
 * The gates as a ladder of rules — struck for the one you are on, inked for
 * the ones behind you, blank for the ones ahead. Only the wizard wears it;
 * settings and repair are not steps in a funnel.
 */
const GATES: readonly { screen: Screen; label: string }[] = [
  { screen: "auth", label: "Account" },
  { screen: "device", label: "Device" },
  { screen: "server", label: "Server" },
  { screen: "possess", label: "Host" },
  { screen: "done", label: "Done" },
];

function gateRail(): string {
  const gates = GATES.filter((gate) => gate.screen !== "device" || deviceGateRequired);
  const here = gates.findIndex((gate) => gate.screen === screen);
  if (here < 0) return "";
  return `
      <ol class="rail" aria-label="Setup progress">
        ${gates
          .map(
            (gate, index) =>
              `<li class="${index === here ? "here" : index < here ? "done" : ""}"${index === here ? ' aria-current="step"' : ""}>${escapeHtml(gate.label)}</li>`,
          )
          .join("")}
      </ol>`;
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

/* The rail below the masthead counts the gates, so this names the surface
 * rather than numbering it — the landing masthead's zone voice. */
function progressLabel(): string {
  const labels: Record<Screen, string> = {
    welcome: "Mac companion",
    auth: "Mac companion",
    device: "Mac companion",
    server: "Mac companion",
    possess: "Mac companion",
    done: "Mac companion",
    settings: "Settings",
    repair: "Repair",
    quit: "Quit",
  };
  return labels[screen];
}

function welcomeView(): string {
  return `
    <section class="sheet wide mark-grid">
      <div class="mark-plate"><span class="trident" aria-hidden="true"></span></div>
      <div class="sheet">
        <div class="masthead">
          <p class="eyebrow">First possession</p>
          <h1>Possess this Mac</h1>
          <p class="lead">Sign in, pick your server, and SPAWN D does the rest — the daemon installed, verified, and kept running. About two minutes.</p>
        </div>
        ${message()}
        <div class="actions"><button class="primary" data-action="get-started">Get started</button></div>
        <details class="installed"><summary>What gets installed?</summary><p>Two binaries in <code>~/.local/bin</code>, one LaunchAgent, nothing else.</p></details>
      </div>
    </section>`;
}

/*
 * The provider's own mark, beside its name on the sign-in button — the same
 * plates web/ draws. Not decoration: Apple's guidelines require its mark to
 * accompany "Sign in with Apple", and Google's branding rules say the same for
 * the G. Apple's is monochrome by rule and takes the button's ink; the rest
 * are drawn at brand colours, which hold on the void ground.
 */
const PROVIDER_MARKS: Record<string, string> = {
  apple:
    '<svg aria-hidden="true" class="provider-mark" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 12.53c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.18-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.21 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.67-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.33-3.54zM14.86 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.7-.92 2.7.97.08 1.97-.49 2.58-1.23z"/></svg>',
  google:
    '<svg aria-hidden="true" class="provider-mark" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z" fill="#34A853"/><path d="M5.84 14.11a6.6 6.6 0 010-4.22V7.05H2.18a11 11 0 000 9.9l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 00-9.82 6.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51z" fill="#EA4335"/></svg>',
  github:
    '<svg aria-hidden="true" class="provider-mark" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.73.5.7 5.57.7 11.86c0 5.03 3.22 9.29 7.69 10.79.56.11.77-.24.77-.54 0-.27-.01-1.16-.02-2.1-3.13.69-3.79-1.34-3.79-1.34-.51-1.31-1.25-1.66-1.25-1.66-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.17 1.72 1.17 1 1.73 2.63 1.23 3.27.94.1-.73.39-1.23.71-1.51-2.5-.29-5.13-1.26-5.13-5.6 0-1.24.44-2.25 1.16-3.04-.12-.29-.5-1.44.11-3 0 0 .95-.31 3.1 1.16a10.6 10.6 0 015.65 0c2.15-1.47 3.09-1.16 3.09-1.16.62 1.56.23 2.71.11 3 .73.79 1.16 1.8 1.16 3.04 0 4.35-2.63 5.31-5.14 5.59.4.35.76 1.04.76 2.1 0 1.52-.01 2.75-.01 3.12 0 .3.2.66.78.54 4.46-1.5 7.68-5.76 7.68-10.79C23.3 5.57 18.27.5 12 .5z"/></svg>',
  microsoft:
    '<svg aria-hidden="true" class="provider-mark" viewBox="0 0 24 24"><path d="M2 2h9.5v9.5H2z" fill="#F25022"/><path d="M12.5 2H22v9.5h-9.5z" fill="#7FBA00"/><path d="M2 12.5h9.5V22H2z" fill="#00A4EF"/><path d="M12.5 12.5H22V22h-9.5z" fill="#FFB900"/></svg>',
};

const PROVIDERS: readonly { id: string; name: string }[] = [
  { id: "google", name: "Google" },
  { id: "github", name: "GitHub" },
  { id: "microsoft", name: "Microsoft" },
  { id: "apple", name: "Apple" },
];

function authView(): string {
  const signup = authMode === "signup";
  return `
    <section class="sheet">
      <div class="masthead">
        <p class="eyebrow">Identity is a device</p>
        <h1>${signup ? "Who summons?" : "Welcome back"}</h1>
        <p class="lead compact">${signup ? "Create the account that will possess this Mac." : "Sign in and this app becomes a revocable device on your account."}</p>
      </div>
      <div class="plate padded form-stack">
        <div class="providers">
          ${PROVIDERS.map(
            (provider) =>
              `<button class="secondary" data-provider="${provider.id}" ${busy ? "disabled" : ""}>${PROVIDER_MARKS[provider.id]}${
                /* Apple's guidelines require this exact wording for its
                   button; every other provider takes the house phrasing. */
                provider.id === "apple" ? "Sign in with Apple" : `Continue with ${provider.name}`
              }</button>`,
          ).join("")}
        </div>
        <div class="rule"><span>or use email</span></div>
        <form id="auth-form" class="form-stack">
          <label><span>Email</span><input name="email" type="email" autocomplete="email" required /></label>
          <label><span>Password</span><input name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="${signup ? "8" : "1"}" ${signup ? 'maxlength="256"' : ""} required /></label>
          ${signup ? '<label><span class="field-head">Invite <span class="optional">if your server requires one</span></span><input name="invite" type="text" autocomplete="off" maxlength="256" /></label>' : ""}
          ${message()}
          <button class="primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Contacting your server…" : signup ? "Create account" : "Sign in"}</button>
        </form>
      </div>
      <div class="auth-links">
        <button class="text-button" data-action="toggle-auth">${signup ? "Already have an account? Sign in" : "Create an account"}</button>
        <button class="text-button server-link" data-action="preauth-server" title="${escapeHtml(preferences.server_origin)}">Using ${escapeHtml(serverHost())} · Change</button>
      </div>
    </section>`;
}

function deviceView(): string {
  const number = deviceProgress.state === "show_number" ? deviceProgress.number : null;
  const refused = deviceProgress.state === "refused" ? deviceProgress.message : null;
  return `
    <section class="sheet">
      <div class="masthead">
        <p class="eyebrow">Device approval</p>
        <h1>Approve this device</h1>
        <p class="lead compact">Approve from a device you already use.</p>
      </div>
      <div class="number-card ${number ? "ready" : "waiting"}">
        <span>${number ? "Type this number there" : "Waiting for an approving device"}</span>
        <strong>${escapeHtml(number ?? "·· ··")}</strong>
        <p>${number ? "The number proves both screens saw the same two device keys." : "A knock is waiting on your other signed-in devices."}</p>
      </div>
      ${refused ? `<div class="message" role="alert">${escapeHtml(refused)}</div>` : message()}
      <div class="actions"><button class="secondary" data-action="ask-again" ${busy ? "disabled" : ""}>Ask again</button></div>
      <p class="fine">This check is never skippable. No device key is trusted until the number matches.</p>
    </section>`;
}

function serverView(): string {
  return `
    <section class="sheet">
      <div class="masthead">
        <p class="eyebrow">Control plane</p>
        <h1>Whose altar?</h1>
        <p class="lead compact">Choose the server this app and the daemon answer to.</p>
      </div>
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
            ? `<label class="advanced"><span>Server URL</span><input name="server-url" type="url" value="${escapeHtml(preferences.server_origin === "https://spawnd.dev" ? "" : preferences.server_origin)}" placeholder="Enter a SPAWN D server URL" required /></label>`
            : ""
        }
        ${message()}
        <div class="actions"><button class="primary" type="submit" ${busy ? "disabled" : ""}>Continue</button></div>
      </form>
    </section>`;
}

const steps = [
  "Daemon downloaded and verified",
  "Host registered — approval ready",
  "Approved — key verified on this machine",
  "Online and ready",
];

function possessView(): string {
  const review = possession?.review;
  const failed = possession?.status === "failed";
  const failure = error ?? (failed ? possession?.error : null);
  const keyMismatch = failure === "This host could not be verified.";
  const serviceFailed = failure === "The daemon installed but its service didn't start.";
  const alreadyPossessed = failure?.includes("already possessed for") ?? false;
  return `
    <section class="sheet wide">
      <div class="masthead">
        <p class="eyebrow">Local install</p>
        <h1>Possess this Mac</h1>
        <p class="lead compact">Both binaries come from ${escapeHtml(preferences.server_origin)} and are checked before installation.</p>
      </div>
      <ol class="progress-list">
        ${steps
          .map(
            (step, index) => `<li class="${completedSteps.has(index) ? "complete" : runId && index === Math.min(completedSteps.size, steps.length - 1) ? "active" : ""}"><span>${completedSteps.has(index) ? "✓" : String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(step)}</p></li>`,
          )
          .join("")}
      </ol>
      ${
        review
          ? approvalReview(review)
          : !runId
            ? `<button class="primary possess-button" data-action="possess" ${busy ? "disabled" : ""}>Possess this Mac</button>`
            : failed
              ? ""
              : possession?.status === "approved"
                ? '<div class="inline-wait"><span class="spinner"></span> Approval complete. Waiting for the daemon to come online…</div>'
                : '<div class="inline-wait"><span class="spinner"></span> The daemon is preparing its identity…</div>'
      }
      ${failed ? `<div class="message" role="alert">${escapeHtml(possessionErrorCopy(possession?.error))}</div>` : message()}
      ${
        failure
          ? keyMismatch
            ? '<div class="actions"><button class="text-button" data-action="learn-key-check">Learn what this means</button></div>'
            : serviceFailed
              ? '<div class="actions"><button class="secondary" data-action="show-repair">Repair</button></div>'
              : alreadyPossessed
                ? '<div class="actions"><button class="secondary" data-action="open-browser">Open SPAWN D</button></div>'
                : '<div class="actions"><button class="secondary" data-action="try-again">Try again</button><button class="text-button" data-action="terminal">Use the Terminal instead</button></div>'
          : ""
      }
      <div class="command-chip"><span class="dollar">$</span><code>${escapeHtml(terminalCommand)}</code><button data-action="copy-command" aria-label="Copy install command">Copy</button></div>
    </section>`;
}

function possessionErrorCopy(reason: string | null | undefined): string {
  if (reason === "This host could not be verified.") return reason;
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
  return `
    <div class="approval-review verified">
      <div><span>${escapeHtml(review.host_name)}</span><strong>Exact key match</strong></div>
      <button class="primary" data-action="approve-host" ${!review.exact_key_match || busy ? "disabled" : ""}>Possess this Mac</button>
    </div>`;
}

function doneView(): string {
  const host = possession?.host_name ?? preferences.host_name ?? "This Mac";
  return `
    <section class="sheet wide mark-grid">
      <div class="mark-plate"><span class="trident" aria-hidden="true"></span></div>
      <div class="sheet">
        <div class="masthead">
          <p class="eyebrow">Possession complete</p>
          <h1>${escapeHtml(host)} is possessed</h1>
          <p class="lead">All your devices can reach it. SPAWN D lives in your menu bar; the daemon keeps running on its own.</p>
        </div>
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
    <section class="sheet wide">
      <div class="section-head">
        <div class="masthead">
          <p class="eyebrow">Menu bar companion</p>
          <h1>Settings</h1>
        </div>
        <button class="close" data-action="close-window" aria-label="Close">×</button>
      </div>
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
    <section class="sheet wide">
      <div class="section-head">
        <div class="masthead">
          <p class="eyebrow">Delegated recovery</p>
          <h1>Repair</h1>
        </div>
        <button class="close" data-action="settings" aria-label="Back to settings">×</button>
      </div>
      <p class="lead compact">SPAWN D asks the daemon to repair itself first. Reinstall remains available only if that does not work.</p>
      <div class="repair-order">
        <button class="primary" data-action="repair-resume" ${busy ? "disabled" : ""}>1 · Re-run spawnd possess</button>
        <button class="secondary" data-action="repair-reinstall" ${busy ? "disabled" : ""}>2 · Verified reinstall</button>
      </div>
      ${message()}
      <div class="log-block">
        <div class="log-head"><span>Recent daemon logs</span><button class="text-button" data-action="copy-logs">Copy</button></div>
        <pre class="logs">${escapeHtml(status?.log_tail || "No daemon log lines are available yet.")}</pre>
      </div>
    </section>`;
}

function quitView(): string {
  return `
    <section class="sheet">
      <div class="masthead">
        <p class="eyebrow">Leave the companion</p>
        <h1>Quit SPAWN D?</h1>
        <p class="lead">The daemon keeps running while SPAWN D is closed.</p>
      </div>
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
    runId = null;
    possession = null;
    completedSteps.clear();
    render();
  } else if (action === "approve-host") await approveHost();
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
  deviceGateRequired = result.approval_required;
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
  const id = await guarded(() => invoke<string>("begin_possession"));
  if (!id) return;
  runId = id;
  possession = null;
  setScreen("possess");
  startPossessionPoll();
}

function startPossessionPoll(): void {
  if (possessionPoll !== null) window.clearInterval(possessionPoll);
  const poll = async (): Promise<void> => {
    if (!runId) return;
    try {
      possession = await invoke<PossessionProgress>("poll_possession", { runId });
      error = null;
      syncPossessionSteps(possession.status);
      if (possession.status === "online") {
        if (possessionPoll !== null) window.clearInterval(possessionPoll);
        possessionPoll = null;
        preferences = await invoke<Preferences>("app_preferences");
        setScreen("done");
        return;
      }
      if (possession.status === "failed") {
        if (possessionPoll !== null) window.clearInterval(possessionPoll);
        possessionPoll = null;
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

function syncPossessionSteps(state: PossessionProgress["status"]): void {
  const count = state === "online" ? 4 : state === "approved" ? 3 : state === "registered" ? 2 : 1;
  if (state === "failed") return;
  for (let index = 0; index < count; index += 1) completedSteps.add(index);
}

async function approveHost(): Promise<void> {
  if (!runId) return;
  const result = await guarded(() => invoke<string>("approve_possession", { runId }));
  if (result) completedSteps.add(2);
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
