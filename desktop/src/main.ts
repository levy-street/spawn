import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./styles.css";

/*
 * The wizard is the browser's funnel, printed locally: the same sign-in and
 * sign-up sheets as /login and /signup, then the same gates the browser's
 * onboarding walks — account, verify, host, done — with one more that only a
 * second device needs, the device approval. Copy, order and rules come from
 * web/src/app/{login,signup}, web/src/components/onboarding/* and
 * web/src/components/hosts/connect-host.tsx; where this app does something the
 * browser cannot (install the daemon itself), the words say so.
 */

type Screen =
  | "auth"
  | "unsupported"
  | "server"
  | "verify"
  | "device"
  | "host"
  | "permissions"
  | "done"
  | "settings"
  | "repair"
  | "stop"
  | "update"
  | "quit";

type Gate = "account" | "verify" | "device" | "host" | "done";

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
  email_verified: boolean;
}

interface AuthProvider {
  id: string;
  name: string;
}

interface AuthConfig {
  providers: AuthProvider[];
  email_verification_required: boolean;
  invite_only: boolean;
}

interface AccountState {
  email: string;
  email_verified: boolean;
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

interface AppUpdate {
  available: boolean;
  version: string | null;
  endpoint: string;
}

/** How far the signed app channel has got with the question it was asked. */
type UpdateCheck = "idle" | "checking" | "done" | "failed";

const HOSTED_ORIGIN = "https://spawnd.dev";
/** The native redirect the server hands a finished sign-in back to. */
const OAUTH_CALLBACK = { host: "auth", path: "/oauth" } as const;
const VERIFY_POLL_MS = 5_000;
const CEREMONY_POLL_MS = 1_500;
const POSSESSION_POLL_MS = 1_500;
/** The browser's SUCCESS_BEAT_MS: a gate lingers this long after it passes. */
const SUCCESS_BEAT_MS = 900;
/** The done gate reads for this long, then the window becomes the product. */
const DONE_BEAT_MS = 1800;
/** Wizard surfaces the tray can ask for by name, carried in the URL hash. */
const SURFACES = new Set<Screen>(["settings", "repair", "update", "quit"]);
const STILL_WAITING_MS = 30_000;
const STALLED_MS = 60_000;
const COPIED_MS = 1_500;
const STATUS_REFRESH_MS = 15_000;
const SESSION_RENEW_MS = 12 * 60 * 60_000;

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("SPAWN D window root is unavailable");
const app: HTMLDivElement = root;

let preferences: Preferences = {
  server_origin: HOSTED_ORIGIN,
  account_id: null,
  account_email: null,
  device_id: null,
  device_approved: false,
  first_run_complete: false,
  host_name: null,
};
let screen: Screen = "auth";
let authMode: "login" | "signup" = "login";
let config: AuthConfig | null = null;
/** Whether the chosen server is new enough for this app; null while unknown. */
let serverSupported: boolean | null = null;
let configState: "loading" | "ready" | "error" = "loading";
let configOrigin: string | null = null;
/** The provider that got as far as the callback on an invite-only server. */
let inviteRequiredFor: string | null = null;
let lastProvider: string | null = null;
let serverChoice: "hosted" | "self" = "hosted";
let error: string | null = null;
let notice: string | null = null;
let busy = false;
let emailVerified = true;
let deviceGateRequired = false;
let deviceProgress: DeviceProgress = { state: "waiting" };
let devicePoll: number | null = null;
let verifyPoll: number | null = null;
let runId: string | null = null;
let possession: PossessionProgress | null = null;
let possessionPoll: number | null = null;
let waitStartedAt: number | null = null;
let ticker: number | null = null;
let copiedUntil = 0;
/**
 * The reader's own answer to the host gate's Terminal panel, or null while
 * they have not given one and the screen decides for them (a failure or a
 * stalled run opens it).
 *
 * Kept here rather than left to the element: the whole screen is re-rendered
 * from `innerHTML` on every poll and every tick, so a `<details>` the reader
 * opened was thrown away and re-created shut about a second later — the panel
 * appeared to close itself the moment they went to read the command.
 */
let terminalOpen: boolean | null = null;
/** Whether this run's approval has been answered already. */
let autoApproved = false;
/**
 * Whether this visit to the host gate has already started a run.
 *
 * The gate possesses on arrival, once. Never twice: a failure has to sit on
 * its own card and wait to be answered, and a gate that restarted itself every
 * time it was rendered would be a loop nobody could get out of.
 */
let hostRunStarted = false;
/**
 * The permissions gate's own error, kept out of `error` on purpose.
 *
 * The possession poll clears `error` on every successful tick, so a message
 * left there while a run is going would vanish about a second later. This gate
 * sits on top of a live run and has to be able to say something that stays.
 */
let permissionsError: string | null = null;
const completedSteps = new Set<number>();
let terminalCommand = `curl -fsSL ${HOSTED_ORIGIN}/install.sh | sh`;
let status: LocalStatus | null = null;
let statusLoading = false;
let appUpdate: AppUpdate | null = null;
let updateCheck: UpdateCheck = "idle";

/* ── Copy ─────────────────────────────────────────────────────────────── */

const GATE_LABELS: Record<Gate, string> = {
  account: "Account",
  verify: "Verify",
  device: "Device",
  host: "Host",
  done: "Done",
};

const PROVIDER_NAMES: Record<string, string> = {
  apple: "Apple",
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
};

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

/** The browser's pairing-failure copy, word for word where the action is the
 * same, and "try again" where the browser says "run spawnd possess again"
 * because here the app runs it. */
const PAIRING_FAILURES: Record<string, string> = {
  expired: "That approval expired. Try again — SPAWN D runs the ceremony afresh.",
  denied: "The approval was declined. Nothing was registered.",
  key_conflict:
    "This machine was set up before, under a different SPAWN D account, and that account still holds its identity. Nothing was changed.\n• To use it under that account: sign in there and approve as usual.\n• To hand it to this account: remove the host from the old account's Hosts page first, then try again.\n• To keep both accounts on this machine: run spawnd possess --new-account in Terminal.",
  pin_conflict:
    "The browser that approved this machine doesn't match its earlier approval. Approve again from a browser you've used with this host before — or remove the host on the web and start fresh.",
  pin_limit:
    "This host has reached its limit of approving browsers (32). Remove old devices under Access, then try again.",
};
const VERIFICATION_REFUSAL = "This host could not be verified.";

/**
 * The ends that are not failures.
 *
 * `spawnd possess` resumes a machine that already carries an instance rather
 * than possessing it twice, and exits without ever minting an approval. The
 * app used to sit on a spinner waiting for one; these say what happened and
 * what the next move is.
 */
const RESUMED: Record<string, { title: string; body: string; action: string }> = {
  already_possessed_here: {
    title: "This Mac is already possessed",
    body: "It already runs SPAWN D for this account, so nothing was changed — its daemon is running in the background and every device you own can reach it.",
    action: '<button class="btn btn-primary" data-action="open-app">Open SPAWN D</button>',
  },
  already_possessed_other: {
    title: "This Mac already runs SPAWN D",
    body: "It is signed in to a different account, and nothing was changed. To run it for this account as well, use the Terminal line below with --new-account — the two instances stay separate.",
    action: '<button class="btn btn-outline" data-action="try-again">Try again</button>',
  },
  no_ceremony: {
    title: "Nothing to approve",
    body: "The daemon finished without asking for approval, and nothing was changed. Try again, or run the Terminal line below and approve from the link it prints.",
    action: '<button class="btn btn-outline" data-action="try-again">Try again</button>',
  },
};
const REFUSAL_MISMATCH =
  "This host's identity could not be verified: the server presented a different identity key than the one in your host's link. Nothing was trusted and no access was granted. This can mean the connection is being tampered with — start over on a network you trust.";
const STALLED_HINT = "Having trouble? Try again — it's safe to repeat.";
const DOCTOR_HINT =
  "Still stuck? Run spawnd doctor in Terminal on this Mac — it checks the daemon, its service, and the connection back here, and says what is wrong.";

/**
 * Setup progress, one row per step the daemon reports (`possess-step`).
 *
 * Three labels, because a row means three different things. Before the button
 * is pressed nothing is happening, and the active labels read there as four
 * things already under way — a download that has not started, over a button
 * that starts it. `todo` is what this Mac is about to be put through; `active`
 * is the one row actually running; `done` is what it left behind.
 */
const HOST_STEPS: readonly { todo: string; active: string; done: string }[] = [
  {
    todo: "Download the daemon",
    active: "Downloading the daemon…",
    done: "Daemon downloaded and verified",
  },
  { todo: "Register this Mac", active: "Registering this Mac…", done: "Registered" },
  { todo: "Approve this Mac", active: "Waiting for approval…", done: "Approved" },
  { todo: "Come online", active: "Connecting…", done: "Online" },
];
/** The one row that waits on the person, not the machine. */
const APPROVAL_STEP = 2;

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const ICON_CIRCLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
const ICON_SPINNER =
  '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
const ICON_MAIL =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
const ICON_ARROW = '<span class="arrow" aria-hidden="true">←</span>';

/* ── Helpers ──────────────────────────────────────────────────────────── */

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

/** The chosen server's host, for the places a full origin would not fit. */
function serverHost(): string {
  try {
    return new URL(preferences.server_origin).host;
  } catch {
    return preferences.server_origin;
  }
}

function providerName(id: string | null): string {
  if (!id) return "your provider";
  return config?.providers.find((provider) => provider.id === id)?.name ?? PROVIDER_NAMES[id] ?? id;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function clearTimer(id: number | null): null {
  if (id !== null) window.clearInterval(id);
  return null;
}

/* ── The sheet ────────────────────────────────────────────────────────── */

const LOCKUP =
  '<div class="lockup"><span class="trident" aria-hidden="true"></span><span class="wordmark" role="img" aria-label="SPAWN D"></span></div>';

const REGISTRATION_MARKS =
  '<span class="marks" aria-hidden="true"><span>+</span><span>+</span><span>+</span><span>+</span></span>';

function sheet(hatch: string, inner: string): string {
  return `<div class="sheet">${REGISTRATION_MARKS}<div class="hatch">${hatch}</div>${inner}</div>`;
}

/** One centred column — the right measure for a sign-in form. */
function stacked(title: string, description: string | null, body: string): string {
  return `
    <div class="stacked">
      ${LOCKUP}
      <section class="plate">
        <header class="plate-head">
          <h1>${title}</h1>
          ${description ? `<p class="lead">${description}</p>` : ""}
        </header>
        <div class="plate-body">${body}</div>
      </section>
    </div>`;
}

/** The masthead ranged against a wider plate — the onboarding gates. A gate
 * whose whole point is one paragraph keeps it together in the plate, where the
 * buttons are, and passes null rather than splitting it across two columns. */
function split(gate: Gate, title: string, description: string | null, body: string): string {
  return `
    <div class="split">
      <header class="split-head">
        ${LOCKUP}
        <h1>${title}</h1>
        ${description ? `<p class="lead">${description}</p>` : ""}
        ${rail(gate)}
      </header>
      <section class="plate plate-padded">${body}</section>
    </div>`;
}

/** The gates this account actually has to pass, in the browser's order, with
 * the device gate slotted in only on runs that need it. */
function gates(): Gate[] {
  const list: Gate[] = ["account"];
  if (config?.email_verification_required) list.push("verify");
  if (deviceGateRequired) list.push("device");
  list.push("host", "done");
  return list;
}

function rail(current: Gate): string {
  const list = gates();
  const here = list.indexOf(current);
  return `
    <ol class="rail" aria-label="Onboarding progress">
      ${list
        .map(
          (gate, index) =>
            `<li class="${index === here ? "here" : index < here ? "done" : ""}"${index === here ? ' aria-current="step"' : ""}>${GATE_LABELS[gate]}</li>`,
        )
        .join("")}
    </ol>`;
}

function hatchServer(): string {
  return `<button class="hatch-link" data-action="choose-server" title="${escapeHtml(preferences.server_origin)}"><span class="host">Using ${escapeHtml(serverHost())}</span><span>· Change</span></button>`;
}

function hatchBack(): string {
  return `<button class="hatch-link" data-action="back-to-auth">${ICON_ARROW} Back</button>`;
}

function hatchAccount(): string {
  const email = preferences.account_email ?? "";
  return `<span class="hatch-link" style="cursor:default"><span class="host">${escapeHtml(email)}</span></span><button class="hatch-link" data-action="sign-out">Sign out</button>`;
}

function errorLine(): string {
  return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
}

function noticeLine(): string {
  return notice ? `<p class="status-line" role="status">${escapeHtml(notice)}</p>` : "";
}

function paceBar(label: string): string {
  return `<div class="pace" role="status" aria-label="${escapeHtml(label)}"><div class="pace-track"><div class="pace-run"></div></div><span class="pace-label">${escapeHtml(label)}</span></div>`;
}

/* ── Screens ──────────────────────────────────────────────────────────── */

function render(): void {
  const views: Record<Screen, () => string> = {
    auth: authView,
    unsupported: unsupportedServerView,
    server: serverView,
    verify: verifyView,
    device: deviceView,
    host: hostView,
    permissions: permissionsView,
    done: doneView,
    settings: settingsView,
    repair: repairView,
    stop: stopView,
    update: updateView,
    quit: quitView,
  };
  app.innerHTML = views[screen]();
  bindActions();
}

function providerButtons(): string {
  const providers = config?.providers ?? [];
  if (configState !== "ready" || providers.length === 0) return "";
  return `
    <div class="stack-tight">
      <div class="providers">
        ${providers
          .map(
            (provider) =>
              `<button class="btn btn-outline btn-block" data-provider="${escapeHtml(provider.id)}" ${busy ? "disabled" : ""}>${PROVIDER_MARKS[provider.id] ?? ""}${
                /* Apple's guidelines require this exact wording for its
                   button; every other provider takes the house phrasing. */
                provider.id === "apple" ? "Sign in with Apple" : `Continue with ${escapeHtml(provider.name)}`
              }</button>`,
          )
          .join("")}
      </div>
      <div class="or-rule"><span>or use email</span></div>
    </div>`;
}

function authView(): string {
  const signup = authMode === "signup";
  const title = signup ? "Create your account" : "Welcome back";
  const description = signup
    ? "Start with an account, then connect the machine where your agents work."
    : "Sign in to reach the shells running across your machines.";

  if (signup && configState === "error") {
    return sheet(
      hatchServer(),
      stacked(
        "Couldn’t load signup",
        "The server’s signup settings are unavailable.",
        `<div class="stack">${errorLine()}<div class="actions"><button class="btn btn-outline" data-action="retry-config">Try again</button></div></div>`,
      ),
    );
  }

  const inviteBanner =
    signup && inviteRequiredFor
      ? `<p class="banner" role="status">${escapeHtml(providerName(inviteRequiredFor))} signed you in, but SPAWN D is invite only right now. Enter your invite code below and continue with ${escapeHtml(providerName(inviteRequiredFor))} again to finish.</p>`
      : "";
  const configNotice =
    !signup && configState === "error"
      ? '<p class="status-line" role="status">Social sign-in is temporarily unavailable. Email sign-in still works.</p>'
      : "";
  const inviteField =
    signup && config?.invite_only
      ? `<label class="field"><span class="label">Invite code</span><input name="invite" type="text" class="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="256" required ${busy ? "disabled" : ""} /></label>`
      : "";

  const body = `
    <div class="stack">
      ${inviteBanner}
      ${providerButtons()}
      ${configNotice}
      <form id="auth-form" class="form" novalidate>
        <label class="field"><span class="label">Email</span><input name="email" type="email" autocomplete="email" autofocus required ${busy ? "disabled" : ""} /></label>
        <div class="field">
          <div class="label-row"><label class="label" for="auth-password">Password</label>${signup ? "" : '<button type="button" class="tiny-link" data-action="forgot-password">Forgot password?</button>'}</div>
          <input id="auth-password" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" ${signup ? 'minlength="8"' : ""} required ${busy ? "disabled" : ""} />
          ${signup ? '<p class="hint">Use at least 8 characters.</p>' : ""}
        </div>
        ${inviteField}
        ${errorLine()}
        <button class="btn btn-primary btn-block" type="submit" ${busy ? "disabled" : ""}>${
          busy ? (signup ? "Creating account…" : "Signing in…") : signup ? "Create account" : "Sign in"
        }</button>
      </form>
      <p class="foot-note">${
        signup
          ? 'Already have an account? <button type="button" class="link" data-action="toggle-auth">Log in</button>'
          : 'No account? <button type="button" class="link" data-action="toggle-auth">Create one</button>'
      }</p>
    </div>`;
  return sheet(hatchServer(), stacked(title, description, body));
}

/**
 * What the signed app channel has said so far.
 *
 * Every state says something — a check under way as much as a settled answer.
 * "Up to date" is a real answer and is said out loud: silence after a press
 * reads as a broken button.
 */
function updateCheckLine(): string {
  const said: Record<UpdateCheck, string> = {
    idle: "",
    checking: "",
    done: "SPAWN D is up to date.",
    failed: "The signed app channel couldn’t be reached, so nothing was installed.",
  };
  // Before an answer, the asking itself is the answer. Never a blank.
  const line = said[updateCheck];
  return line
    ? `<p class="note">${escapeHtml(line)}</p>`
    : paceBar("Checking the signed app channel…");
}

/**
 * A server this app cannot finish a sign-in against.
 *
 * Not a dead end, and it must never look like one. It may not even be the
 * server that is behind: this app rides its own updater channel, so it can be
 * the older half of the pair. Two rules hold this screen:
 *
 * - It never appears without saying something is being done. The channel is
 *   asked the moment `serverSupported` comes back false (`loadConfig`), and
 *   the asking is on screen while it runs — not a wall of prose with two
 *   buttons under it.
 * - Every answer is said out loud: checking, a version to install, already
 *   current, or a channel that could not be reached and what that leaves.
 *   Silence after a press reads as a broken button.
 *
 * "Check for updates" therefore stays whatever the answer was, so it can be
 * pressed again once the automatic check has settled. It is a second action
 * beside the two that do not depend on the channel at all, never a
 * replacement for them — and the bone slab stays the one thing to do.
 */
function unsupportedServerView(): string {
  const ready = appUpdate?.available ?? false;
  // `idle` is unreachable here — reaching this screen is what starts the check
  // — and a blank where the answer goes is the one thing this screen must
  // never show, so it reads as the beat before the first answer.
  const settled = updateCheck === "done" || updateCheck === "failed";
  let channel: string;
  if (!settled) {
    channel = paceBar("Checking for a newer SPAWN D…");
  } else if (ready) {
    channel = `<div class="inset" role="status"><p><strong>SPAWN D ${escapeHtml(appUpdate?.version ?? "")} is ready</strong></p><p class="muted">A newer app may already know the way round this. It comes from the signed app channel and restarts itself; the daemon on this Mac is not touched.</p></div>`;
  } else if (updateCheck === "failed") {
    channel = `<p class="status-line" role="status">${escapeHtml("The signed app channel couldn’t be reached, so whether a newer SPAWN D exists is unknown. Nothing on this Mac has changed.")}</p>`;
  } else {
    channel = `<p class="status-line" role="status">${escapeHtml("SPAWN D is already the current release — this server is the half that is behind.")}</p>`;
  }

  const actions = [
    ready
      ? `<button class="btn btn-primary" data-action="install-update" ${busy ? "disabled" : ""}>${busy ? "Installing…" : "Install and restart"}</button>`
      : "",
    `<button class="btn ${ready ? "btn-outline" : "btn-primary"}" data-action="choose-server">Choose another server</button>`,
    '<button class="btn btn-ghost" data-action="retry-config">Try again</button>',
    `<button class="btn btn-ghost" data-action="recheck-update" ${settled ? "" : "disabled"}>${settled ? "Check for updates" : "Checking…"}</button>`,
  ].join("");
  return sheet(
    hatchServer(),
    stacked(
      "That server is out of date",
      `${escapeHtml(serverHost())} is running an older SPAWN D than this app needs.`,
      `<div class="stack"><div class="inset"><p class="muted">Signing in here needs an endpoint this server does not have yet, and this Mac could not be possessed by it. Update the server to the current release, point SPAWN D at another one — or update this app, in case it is the half that is behind.</p></div>${channel}${errorLine()}<div class="actions">${actions}</div></div>`,
    ),
  );
}

function serverView(): string {
  const body = `
    <form id="server-form" class="stack">
      <label class="option ${serverChoice === "hosted" ? "selected" : ""}">
        <input type="radio" name="server-kind" value="hosted" ${serverChoice === "hosted" ? "checked" : ""} />
        <span><strong>spawnd.dev</strong><small>Hosted. Fastest start.</small></span>
      </label>
      <label class="option ${serverChoice === "self" ? "selected" : ""}">
        <input type="radio" name="server-kind" value="self" ${serverChoice === "self" ? "checked" : ""} />
        <span><strong>Self-hosted</strong><small>A server you run. The strongest trust stance — the server only ever relays.</small></span>
      </label>
      ${
        serverChoice === "self"
          ? `<label class="field"><span class="label">Server URL</span><input name="server-url" type="url" value="${escapeHtml(preferences.server_origin === HOSTED_ORIGIN ? "" : preferences.server_origin)}" placeholder="https://spawn.example.com" autocomplete="url" spellcheck="false" required /></label>`
          : ""
      }
      ${errorLine()}
      <div class="actions"><button class="btn btn-primary" type="submit" ${busy ? "disabled" : ""}>Continue</button><button class="btn btn-ghost" type="button" data-action="back-to-auth">Cancel</button></div>
    </form>`;
  return sheet(
    hatchBack(),
    stacked("Choose your server", "The server this app and the daemon on this Mac answer to.", body),
  );
}

function verifyView(): string {
  const email = preferences.account_email ?? "your address";
  const body = `
    <div class="stack">
      <div class="inset">
        <span aria-hidden="true" style="color: var(--ember)">${ICON_MAIL}</span>
        <p>We sent a link to <strong>${escapeHtml(email)}</strong>.</p>
        <p class="muted">Open it in any tab. This app checks every five seconds and will continue automatically.</p>
      </div>
      ${noticeLine()}
      ${errorLine()}
      <div class="actions"><button class="btn btn-outline" data-action="resend-verification" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Resend email"}</button></div>
    </div>`;
  return sheet(
    hatchAccount(),
    split("verify", "Check your inbox", "Confirm this address before connecting a machine.", body),
  );
}

function deviceView(): string {
  const progress = deviceProgress;
  let body: string;
  if (progress.state === "show_number") {
    body = `
      <div class="inset centered">
        <p class="number-title">Your number</p>
        <p class="number">${escapeHtml(progress.number)}</p>
        <p class="number-help">Enter this number on the device you already use.</p>
      </div>`;
  } else if (progress.state === "refused") {
    body = `<div class="failure"><h3>The number wasn’t right</h3><p>${escapeHtml(progress.message)}</p></div>`;
  } else {
    body = `
      <div class="inset">
        <p>Waiting for approval…</p>
        <p class="muted">Your other devices have been asked. This closes on its own once one approves.</p>
        ${paceBar("Waiting for a device you already use")}
      </div>`;
  }
  const plate = `
    <div class="stack">
      ${body}
      ${errorLine()}
      <div class="actions"><button class="btn btn-outline" data-action="ask-again" ${busy ? "disabled" : ""}>Ask again</button></div>
      <p class="note">The number only appears here, so nobody can approve a device they are not holding. A mismatch is terminal — nothing is trusted until it matches.</p>
    </div>`;
  return sheet(
    hatchAccount(),
    split("device", "Approve this device", "Approve it from a device you already use.", plate),
  );
}

function elapsedMs(): number {
  return waitStartedAt === null ? 0 : Date.now() - waitStartedAt;
}

/**
 * Setup progress, one row per step.
 *
 * There is no idle state and no heading any more. The gate possesses the
 * moment it is reached, so the first row is already the one under way from the
 * first paint — there is no "before" for this list to describe, and a heading
 * that turned from a plan into a report a beat later was only ever a flash.
 * `stopped` is a failure of any kind: nothing is running, so no row spins.
 */
function hostChecklist(stopped: boolean): string {
  const current = stopped ? -1 : Math.min(completedSteps.size, HOST_STEPS.length - 1);
  const waitsOnPerson = current === APPROVAL_STEP && possession?.review !== null && possession?.review !== undefined;
  const elapsed = elapsedMs();
  return `
    <ol class="checklist" aria-label="Setup progress">
      ${HOST_STEPS.map((step, index) => {
        const complete = completedSteps.has(index);
        const state = complete ? "complete" : index === current ? "current" : "pending";
        const icon = complete ? ICON_CHECK : state === "current" && !waitsOnPerson ? ICON_SPINNER : ICON_CIRCLE;
        const label = complete ? step.done : state === "current" ? step.active : step.todo;
        const aside =
          state === "current" && !waitsOnPerson && elapsed >= STILL_WAITING_MS && elapsed < STALLED_MS
            ? '<span class="aside">Still waiting…</span>'
            : "<span></span>";
        return `<li class="${state}" data-state="${state}"><span class="mark" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span>${aside}</li>`;
      }).join("")}
    </ol>`;
}

function hostView(): string {
  const review = possession?.review ?? null;
  const failed = possession?.status === "failed";
  const failure = error ?? (failed ? possession?.error : null) ?? null;
  const refused = failure === VERIFICATION_REFUSAL;
  const serviceFailed = failure === "The daemon installed but its service didn't start.";
  const elapsed = elapsedMs();
  const stalled = runId && !failed && !review && elapsed >= STALLED_MS;
  // Every end that is not progress, including the one review whose answer is
  // no: nothing is running, so no row on the checklist may go on spinning.
  const stopped = failure !== null || (review !== null && !review.exact_key_match);

  let action: string;
  if (refused) {
    action = `
      <div class="failure" data-testid="possess-refusal"><h3>This host could not be verified</h3><p>${escapeHtml(REFUSAL_MISMATCH)}</p></div>
      <div class="actions"><button class="btn btn-outline" data-action="try-again">Start over</button></div>`;
  } else if (failure && RESUMED[failure]) {
    const resumed = RESUMED[failure];
    action = `
      <div class="inset" role="status"><p><strong>${escapeHtml(resumed.title)}</strong></p><p class="muted">${escapeHtml(resumed.body)}</p></div>
      <div class="actions">${resumed.action}</div>`;
  } else if (failure) {
    action = `
      <div class="failure" role="alert"><h3>This machine was not approved</h3><p>${escapeHtml(pairingFailureCopy(failure))}</p></div>
      <div class="actions">${
        serviceFailed
          ? '<button class="btn btn-outline" data-action="show-repair">Repair</button>'
          : '<button class="btn btn-outline" data-action="try-again">Try again</button>'
      }</div>`;
  } else if (review && !review.exact_key_match) {
    // The one review that is still a question — and the answer is no. The key
    // the server presented is not the one this Mac's daemon printed, so there
    // is nothing to approve here, only something to walk away from.
    action = `
      <div class="failure" data-testid="possess-refusal"><h3>This host could not be verified</h3><p>${escapeHtml(REFUSAL_MISMATCH)}</p></div>
      <div class="actions"><button class="btn btn-outline" data-action="try-again">Start over</button></div>`;
  } else if (review) {
    // Approved without asking. The browser asks because it is a stranger to
    // the machine in the link; this app *is* the machine — it ran the install,
    // it holds the account, and it has just matched the key its own daemon
    // printed. A prompt there asks you to confirm what you are watching.
    action = `
      <div class="inset" role="status" data-testid="possess-approve-screen">
        <p><strong>Approving ${escapeHtml(review.host_name)}</strong></p>
        <p class="muted">SPAWN D matched this Mac’s identity against the link its daemon printed. All your devices get access to it.</p>
        ${paceBar(`Approving ${review.host_name}…`)}
      </div>`;
  } else if (possession?.status === "approved") {
    action = `<div class="inset"><p>Connecting</p><p class="muted">Approved. The daemon is starting up and calling home — this usually takes a few seconds.</p>${paceBar("Waiting for this Mac to come online…")}</div>`;
  } else {
    action = "";
  }

  // A run that has gone quiet for a minute is not progress. Say so, offer the
  // way out of it, and stop pretending the next row is about to tick.
  const hints = stalled
    ? `<p class="note">${escapeHtml(STALLED_HINT)}</p><p class="note">${escapeHtml(DOCTOR_HINT)}</p>
       <div class="actions"><button class="btn btn-outline" data-action="try-again">Start over</button></div>`
    : "";

  const copied = Date.now() < copiedUntil;
  const terminal = `
    <details ${(terminalOpen ?? ((failure && !refused && failure !== "already_possessed_here") || stalled)) ? "open" : ""} data-panel="terminal">
      <summary>Use the Terminal instead</summary>
      <div class="stack-tight">
        <div class="chip"><span class="dollar">$</span><code>${escapeHtml(terminalCommand)}</code><button type="button" class="${copied ? "done" : ""}" data-action="copy-command" aria-label="Copy install command">${copied ? "Copied" : "Copy"}</button></div>
        <p class="note">After installation, run <code>spawnd possess</code> on this Mac.</p>
        <p class="note">Already running SPAWN D for another account on this Mac? Add <code>--new-account</code>.</p>
      </div>
    </details>`;

  const body = `
    <div class="stack-loose">
      ${hostChecklist(stopped)}
      ${action}
      ${hints}
      ${terminal}
    </div>`;
  return sheet(
    hatchAccount(),
    split(
      "host",
      "Possess this Mac",
      `SPAWN D installs the daemon from ${escapeHtml(serverHost())}, verifies it, and approves it here — the same ceremony the terminal link runs, without the terminal.`,
      body,
    ),
  );
}

function pairingFailureCopy(reason: string): string {
  return PAIRING_FAILURES[reason] ?? reason;
}

/**
 * The beat before macOS interrupts, between Approved and Online.
 *
 * The daemon primes Desktop, Documents and Downloads once, on the first
 * registration after possession, and never asks again — but a refusal is
 * sticky, so the asking only happens with someone at the screen to answer it.
 * This is that screen, and it exists to make three unexplained system dialogs
 * into one thing the person chose a moment earlier.
 *
 * It is a gate, not a wall, and it is not a last chance either way:
 *
 * - "Not now" means "don't ask me in a batch", not "never". The host still
 *   comes online, and a folder nobody granted asks for itself the first time
 *   an agent touches it.
 * - Walking away is also an answer. The daemon waits two minutes, then goes on
 *   without priming and without recording a refusal, so the next possession
 *   can offer this again. Nothing here says "now or never", because it isn't.
 *
 * The plate is deliberately bare — no checklist, no terminal panel. macOS is
 * about to put three dialogs over this window, and the only thing worth
 * reading first is what they are for.
 */
function permissionsView(): string {
  const body = `
    <div class="stack">
      <div class="inset">
        <p>macOS will ask three times — Desktop, Documents, Downloads. SPAWN D needs them to open the files you and your agents work on. Nothing is read until you ask for it.</p>
      </div>
      ${permissionsError ? `<p class="error" role="alert">${escapeHtml(permissionsError)}</p>` : ""}
      <div class="actions">
        <button class="btn btn-primary" data-action="permissions-continue" ${busy ? "disabled" : ""}>${busy ? "Asking…" : "Continue"}</button>
        <button class="btn btn-ghost" data-action="permissions-skip" ${busy ? "disabled" : ""}>Not now</button>
      </div>
    </div>`;
  // No masthead lead: the paragraph is one thought and stays whole, in the
  // plate, beside the buttons — which is where someone is looking when they
  // decide. Split across the two columns it read as two half-sentences.
  return sheet(hatchAccount(), split("host", "Permissions", null, body));
}

/**
 * The last gate, which nobody has to press through: it reads for a beat and
 * then the window becomes the product. A button here only ever asked someone
 * to confirm what was already happening — so the only control on this screen
 * is the one that appears if the opening fails.
 */
function doneView(): string {
  const host = possession?.host_name ?? preferences.host_name ?? "This Mac";
  const body = `
    <div class="stack">
      <div class="inset">
        <p><strong>${escapeHtml(host)}</strong> is online. All your devices can reach it.</p>
        <p class="muted">${
          error
            ? "The window couldn’t open the app — that is this app, not this Mac. Your host stays online and the daemon keeps running either way."
            : "SPAWN D opens in a moment. It stays in your menu bar; the daemon keeps running on its own."
        }</p>
        ${busy ? paceBar("Opening SPAWN D…") : ""}
      </div>
      ${errorLine()}
      ${error ? '<div class="actions"><button class="btn btn-primary" data-action="open-app">Try again</button></div>' : ""}
    </div>`;
  return sheet(
    hatchAccount(),
    split(
      "done",
      "Your machine is possessed",
      "Pick a folder on it and summon your first wall of terminals.",
      body,
    ),
  );
}

function settingsView(): string {
  const instances = status?.status.instances;
  const instance = Array.isArray(instances) ? instances[0] : null;
  const connected = status?.heartbeat?.connected ?? false;
  const body = `
    <div class="stack">
      <div class="status-band"><span class="status-dot ${connected ? "online" : ""}"></span><div><strong>${connected ? "Possessed, online" : status ? "Possessed, offline" : "Checking this Mac…"}</strong><small>${escapeHtml(preferences.host_name ?? "This Mac")} · ${escapeHtml(serverHost())}${preferences.account_email ? ` · ${escapeHtml(preferences.account_email)}` : ""}</small></div></div>
      <div class="menu">
        <button data-action="open-app"><span><strong>Open SPAWN D</strong><small>Your workspaces and terminals, in this app</small></span><b>↗</b></button>
        <button data-action="show-repair"><span><strong>Repair…</strong><small>Run the daemon’s own recovery path</small></span><b>›</b></button>
        <button data-action="check-update"><span><strong>Update SPAWN D…</strong><small>${appUpdate?.available ? `Version ${escapeHtml(appUpdate.version)} is ready` : "Check the signed app channel"}</small></span><b>${appUpdate?.available ? "↓" : "↻"}</b></button>
        <button class="danger" data-action="confirm-stop"><span><strong>Stop possessing this Mac…</strong><small>Removes the daemon service and this Mac’s registration</small></span><b>—</b></button>
      </div>
      ${errorLine()}
      <details class="diagnostics"><summary>Daemon details</summary><pre>${escapeHtml(JSON.stringify(instance ?? status?.status ?? {}, null, 2))}</pre></details>
    </div>`;
  return sheet(
    "",
    `<div class="stacked">${LOCKUP}<section class="plate"><header class="plate-head with-close"><div><h1>Settings</h1><p class="lead">SPAWN D lives in your menu bar.</p></div><button class="close" data-action="close-window" aria-label="Back to SPAWN D">×</button></header><div class="plate-body">${body}</div></section></div>`,
  );
}

function repairView(): string {
  const body = `
    <div class="stack">
      <div class="actions stacked-actions">
        <button class="btn btn-primary" data-action="repair-resume" ${busy ? "disabled" : ""}>${busy ? "Working…" : "1 · Re-run spawnd possess"}</button>
        <button class="btn btn-outline" data-action="repair-reinstall" ${busy ? "disabled" : ""}>2 · Verified reinstall</button>
      </div>
      ${noticeLine()}
      ${errorLine()}
      <div class="stack-tight">
        <div class="log-head"><span class="label">Recent daemon logs</span><button class="tiny-link" data-action="copy-logs">Copy</button></div>
        <pre class="logs">${escapeHtml(status?.log_tail || "No daemon log lines are available yet.")}</pre>
      </div>
    </div>`;
  return sheet(
    "",
    `<div class="stacked">${LOCKUP}<section class="plate"><header class="plate-head with-close"><div><h1>Repair</h1><p class="lead">SPAWN D asks the daemon to repair itself first. A verified reinstall stays available if that does not work.</p></div><button class="close" data-action="settings" aria-label="Back to settings">×</button></header><div class="plate-body">${body}</div></section></div>`,
  );
}

function stopView(): string {
  const body = `
    <div class="stack">
      <p class="note">This runs <code>spawnd exorcise</code>: the daemon service and this Mac’s registration are removed. Your account and the app stay.</p>
      ${errorLine()}
      <div class="actions"><button class="btn btn-outline danger" data-action="stop-possessing" ${busy ? "disabled" : ""}>${busy ? "Stopping…" : "Stop possessing"}</button><button class="btn btn-ghost" data-action="settings">Cancel</button></div>
    </div>`;
  return sheet("", stacked("Stop possessing this Mac?", "The daemon stops answering for this Mac. Nothing else is touched.", body));
}

function updateView(): string {
  const available = appUpdate?.available ?? false;
  const body = available
    ? `
    <div class="stack">
      <p class="note">SPAWN D ${escapeHtml(appUpdate?.version ?? "")} is ready from the signed app channel. The app restarts after installing; the daemon is not touched.</p>
      ${errorLine()}
      <div class="actions"><button class="btn btn-primary" data-action="install-update" ${busy ? "disabled" : ""}>${busy ? "Installing…" : "Install and restart"}</button><button class="btn btn-ghost" data-action="settings">Not now</button></div>
    </div>`
    : `
    <div class="stack">
      ${updateCheckLine()}
      ${errorLine()}
      <div class="actions"><button class="btn btn-outline" data-action="recheck-update" ${updateCheck === "checking" ? "disabled" : ""}>${updateCheck === "checking" ? "Checking…" : "Check again"}</button><button class="btn btn-ghost" data-action="settings">Close</button></div>
    </div>`;
  return sheet("", stacked("Update SPAWN D", null, body));
}

function quitView(): string {
  const body = `
    <div class="stack">
      <p class="note">The daemon keeps running while SPAWN D is closed. Your hosts stay reachable.</p>
      <div class="actions"><button class="btn btn-primary" data-action="quit-app">Quit SPAWN D</button><button class="btn btn-ghost" data-action="settings">Cancel</button></div>
    </div>`;
  return sheet("", stacked("Quit SPAWN D?", null, body));
}

/* ── Actions ──────────────────────────────────────────────────────────── */

function bindActions(): void {
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((element) => {
    element.addEventListener("click", () => void act(element.dataset.action ?? ""));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-provider]").forEach((element) => {
    element.addEventListener("click", () => void beginOAuth(element.dataset.provider ?? ""));
  });
  document.querySelector<HTMLFormElement>("#auth-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!form.reportValidity()) return;
    void submitAuth(new FormData(form));
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
  const terminalPanel = document.querySelector<HTMLDetailsElement>('details[data-panel="terminal"]');
  // Both, and the click is the one that matters. A run re-renders this whole
  // screen every second, and `toggle` arrives in a later task — late enough
  // that the panel it was about is gone and the answer is lost, so the next
  // render closed the panel a beat after it was opened. The click lands first,
  // while the element is still the one that was pressed.
  terminalPanel?.querySelector("summary")?.addEventListener("click", () => {
    terminalOpen = !terminalPanel.open;
  });
  terminalPanel?.addEventListener("toggle", (event) => {
    terminalOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
}

async function act(action: string): Promise<void> {
  error = null;
  switch (action) {
    case "toggle-auth":
      authMode = authMode === "login" ? "signup" : "login";
      render();
      break;
    case "choose-server":
      serverChoice = preferences.server_origin === HOSTED_ORIGIN ? "hosted" : "self";
      setScreen("server");
      break;
    case "back-to-auth":
      setScreen("auth");
      break;
    case "retry-config":
      await loadConfig(true);
      break;
    case "forgot-password":
      await openUrl(`${preferences.server_origin}/forgot-password`);
      break;
    case "sign-out":
      await signOut();
      break;
    case "resend-verification":
      await resendVerification();
      break;
    case "ask-again":
      await guarded(() => invoke("ask_for_device_approval"));
      break;
    // "Try again" and "Start over" mean what they say: the gate runs again,
    // because a press is the only thing that restarts it.
    case "try-again":
    case "repair-reinstall":
      await startPossession();
      break;
    case "approve-host":
      await approveHost();
      break;
    case "permissions-continue":
      await answerPermissions(true);
      break;
    case "permissions-skip":
      await answerPermissions(false);
      break;
    case "copy-command":
      await navigator.clipboard.writeText(terminalCommand);
      copiedUntil = Date.now() + COPIED_MS;
      render();
      window.setTimeout(render, COPIED_MS + 50);
      break;
    case "open-app":
      // The product itself: this window becomes the web app, signed in.
      await guarded(() => invoke("open_app"));
      break;
    case "close-window":
      // Once this Mac is possessed the window is the product; leaving a
      // wizard surface means going back to it, not to the menu bar.
      if (preferences.first_run_complete) await guarded(() => invoke("open_app"));
      else window.close();
      break;
    case "settings":
      setScreen("settings");
      await refreshStatus(false);
      break;
    case "show-repair":
      setScreen("repair");
      await refreshStatus(true);
      break;
    case "repair-resume":
      notice = null;
      if ((await guarded(() => invoke<string>("repair_resume"))) !== null) notice = "The daemon re-ran its possession. Check the logs below.";
      await refreshStatus(true);
      break;
    case "copy-logs":
      await navigator.clipboard.writeText(status?.log_tail ?? "");
      break;
    case "check-update":
      setScreen("update");
      await checkUpdate();
      break;
    // The same question, asked from wherever the reader already is.
    case "recheck-update":
      await checkUpdate();
      break;
    case "install-update":
      await guarded(() => invoke<boolean>("install_app_update"));
      break;
    case "confirm-stop":
      setScreen("stop");
      break;
    case "stop-possessing":
      if ((await guarded(() => invoke<string>("stop_possessing"))) !== null) {
        setScreen("settings");
        await refreshStatus(true);
      }
      break;
    case "quit-app":
      await invoke("quit_app");
      break;
    default:
      break;
  }
}

function setScreen(next: Screen): void {
  screen = next;
  error = null;
  notice = null;
  render();
}

async function guarded<T>(operation: () => Promise<T>): Promise<T | null> {
  busy = true;
  error = null;
  render();
  try {
    return await operation();
  } catch (cause) {
    error = describe(cause);
    return null;
  } finally {
    busy = false;
    render();
  }
}

/* ── Sign-in ──────────────────────────────────────────────────────────── */

async function loadConfig(force = false): Promise<void> {
  if (!force && configOrigin === preferences.server_origin && configState === "ready") return;
  configState = "loading";
  configOrigin = preferences.server_origin;
  render();
  // What the server can do, before what it offers: one too old to finish a
  // sign-in should say so here, not with a bare error halfway through one. An
  // unreachable server leaves this unknown and blocks nothing.
  serverSupported = await invoke<boolean>("server_supported", {
    origin: preferences.server_origin,
  }).catch(() => null);
  // A server this app cannot finish a sign-in against may be the pair's newer
  // half. Ask the app's own channel before the screen has to be read, so it
  // arrives with the answer rather than another thing to press.
  if (serverSupported === false) {
    void checkUpdate();
    if (!preferences.first_run_complete) setScreen("unsupported");
  } else if (screen === "unsupported") {
    // It answers now — the server was updated while this screen was up, or
    // another one was chosen. Put the person back where they belong.
    await advance();
  }
  try {
    config = await invoke<AuthConfig>("auth_config", { origin: preferences.server_origin });
    configState = "ready";
  } catch (cause) {
    config = null;
    configState = "error";
    error = null;
    console.warn("auth config unavailable:", describe(cause));
  }
  render();
}

async function submitAuth(data: FormData): Promise<void> {
  const email = String(data.get("email") ?? "").trim();
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
  lastProvider = provider;
  const inviteInput = document.querySelector<HTMLInputElement>('input[name="invite"]');
  const invite = inviteInput?.value.trim() || null;
  const url = await guarded(() =>
    invoke<string>("oauth_start_url", { origin: preferences.server_origin, provider, invite }),
  );
  if (url) await openUrl(url);
}

async function handleDeepLink(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol !== "spawn:" || url.hostname !== OAUTH_CALLBACK.host || url.pathname !== OAUTH_CALLBACK.path) return;
  const oauthError = url.searchParams.get("error");
  if (oauthError === "invite_required") {
    // The provider signed the person in, but the server wants a code before it
    // will create the account. Show the field and let them go again.
    authMode = "signup";
    inviteRequiredFor = lastProvider;
    setScreen("auth");
    return;
  }
  if (oauthError) {
    setScreen("auth");
    error = oauthError === "access_denied" ? `${providerName(lastProvider)} sign-in was cancelled.` : oauthError;
    render();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) return;
  setScreen("auth");
  const result = await guarded(() =>
    invoke<AuthOutcome>("exchange_oauth_code", { origin: preferences.server_origin, code }),
  );
  if (result) {
    inviteRequiredFor = null;
    await finishAuth(result);
  }
}

async function finishAuth(result: AuthOutcome): Promise<void> {
  preferences = await invoke<Preferences>("app_preferences");
  deviceGateRequired = result.approval_required;
  emailVerified = result.email_verified;
  await advance();
}

/** The gate after this one, by the browser's rule: verify before anything
 * that consumes a host, then the device ceremony, then the host itself. */
async function advance(): Promise<void> {
  if (!preferences.account_id) {
    setScreen("auth");
    return;
  }
  if (config?.email_verification_required && !emailVerified) {
    setScreen("verify");
    startVerifyPoll();
    return;
  }
  if (deviceGateRequired && !preferences.device_approved) {
    setScreen("device");
    startDevicePoll();
    return;
  }
  // The host gate is where an out-of-date server actually bites, and this is
  // the only place a stored account ever passed. Without it, `initialize()`
  // walked straight from a saved session into a possession that failed with a
  // pairing error saying nothing about the server's age, and the screen that
  // explains it — and offers the app update — was never reached at all.
  //
  // Here rather than in front of every gate, on purpose. `POST
  // /api/auth/session/renew` is the sentinel, and it backs sign-in, the
  // periodic renewal and the browser handover — not possession, which
  // `install.rs` completes without it. So a stale server does not stop this
  // Mac working; it stops the *ending* working, and the person still has real
  // choices here because nothing is committed yet. A Mac that is already
  // possessed never reaches this line, which is the point: taking a working
  // machine away over a degraded handover would be the worse bug.
  if (serverSupported === false && !preferences.first_run_complete) {
    setScreen("unsupported");
    return;
  }
  setScreen("host");
  // The gate has nothing to ask. This app holds the account, it runs the
  // install itself, and it verifies the daemon's key against the link its own
  // daemon printed — a button here was a question with one answer. Once per
  // arrival, so a failure stays a failure until someone answers it.
  if (!hostRunStarted) void startPossession();
}

async function signOut(): Promise<void> {
  stopPolls();
  resetPossession();
  hostRunStarted = false;
  await guarded(() => invoke("sign_out"));
  preferences = await invoke<Preferences>("app_preferences");
  deviceGateRequired = false;
  emailVerified = true;
  inviteRequiredFor = null;
  authMode = "login";
  setScreen("auth");
}

async function submitServer(data: FormData): Promise<void> {
  const origin = serverChoice === "hosted" ? HOSTED_ORIGIN : String(data.get("server-url") ?? "");
  if (origin !== preferences.server_origin && preferences.account_id) {
    await invoke("sign_out");
  }
  const normalized = await guarded(() => invoke<string>("choose_server", { serverUrl: origin }));
  if (!normalized) return;
  preferences = await invoke<Preferences>("app_preferences");
  terminalCommand = await invoke<string>("terminal_install_command");
  inviteRequiredFor = null;
  // Another server is another possession; the gate gets a fresh arrival.
  resetPossession();
  hostRunStarted = false;
  setScreen("auth");
  await loadConfig(true);
}

/* ── Verify ───────────────────────────────────────────────────────────── */

function startVerifyPoll(): void {
  verifyPoll = clearTimer(verifyPoll);
  const poll = async (): Promise<void> => {
    if (screen !== "verify") return;
    try {
      const state = await invoke<AccountState>("account_state");
      if (state.email_verified) {
        verifyPoll = clearTimer(verifyPoll);
        emailVerified = true;
        notice = "Email verified. Moving on…";
        error = null;
        render();
        window.setTimeout(() => void advance(), SUCCESS_BEAT_MS);
      }
    } catch (cause) {
      error = describe(cause);
      render();
    }
  };
  void poll();
  verifyPoll = window.setInterval(() => void poll(), VERIFY_POLL_MS);
}

async function resendVerification(): Promise<void> {
  notice = null;
  const sent = await guarded(() => invoke("request_email_verification"));
  if (sent !== null) {
    notice = "A fresh verification link is on its way.";
  } else if (error?.includes("too many requests")) {
    error = "You’ve requested several links already. Please wait a while before trying again.";
  } else if (error) {
    error = "Could not send another link. Please try again.";
  }
  render();
}

/* ── Device approval ──────────────────────────────────────────────────── */

function startDevicePoll(): void {
  devicePoll = clearTimer(devicePoll);
  const poll = async (): Promise<void> => {
    if (screen !== "device") return;
    try {
      deviceProgress = await invoke<DeviceProgress>("poll_device_approval");
      if (deviceProgress.state === "approved") {
        devicePoll = clearTimer(devicePoll);
        preferences = await invoke<Preferences>("app_preferences");
        notice = "This device is approved. Moving on…";
        render();
        window.setTimeout(() => void advance(), SUCCESS_BEAT_MS);
        return;
      }
      render();
    } catch (cause) {
      error = describe(cause);
      render();
    }
  };
  void poll();
  devicePoll = window.setInterval(() => void poll(), CEREMONY_POLL_MS);
}

/* ── Host ─────────────────────────────────────────────────────────────── */

function resetPossession(): void {
  terminalOpen = null;
  autoApproved = false;
  permissionsError = null;
  possessionPoll = clearTimer(possessionPoll);
  ticker = clearTimer(ticker);
  runId = null;
  possession = null;
  waitStartedAt = null;
  completedSteps.clear();
}

/**
 * Possess this Mac.
 *
 * The gate is on screen before the daemon is even asked for, so the wait for
 * `begin_possession` is reported by the checklist's first row rather than by
 * a button that says "Starting…" — and a repair that reinstalls arrives at the
 * gate at once instead of a beat later.
 */
async function startPossession(): Promise<void> {
  resetPossession();
  hostRunStarted = true;
  setScreen("host");
  const id = await guarded(() => invoke<string>("begin_possession"));
  if (!id) return;
  runId = id;
  waitStartedAt = Date.now();
  startPossessionPoll();
  ticker = window.setInterval(() => {
    if (screen === "host" && runId) render();
  }, 1_000);
}

function startPossessionPoll(): void {
  possessionPoll = clearTimer(possessionPoll);
  let lastStatus: PossessionProgress["status"] | null = null;
  const poll = async (): Promise<void> => {
    if (!runId) return;
    try {
      possession = await invoke<PossessionProgress>("poll_possession", { runId });
      error = null;
      if (possession.status !== lastStatus) {
        lastStatus = possession.status;
        waitStartedAt = Date.now();
      }
      syncPossessionSteps(possession.status);
      // The review is this app's to answer, and it has already checked the
      // only thing the answer depends on. Once per run, never on a mismatch.
      if (possession.review?.exact_key_match && !autoApproved) {
        autoApproved = true;
        await approveHost();
        render();
        return;
      }
      if (possession.status === "online") {
        possessionPoll = clearTimer(possessionPoll);
        ticker = clearTimer(ticker);
        preferences = await invoke<Preferences>("app_preferences");
        notice = "Your host is online.";
        render();
        window.setTimeout(() => {
          setScreen("done");
          // The product is the point: the window becomes it once the
          // gate has been read.
          window.setTimeout(() => void guarded(() => invoke("open_app")), DONE_BEAT_MS);
        }, SUCCESS_BEAT_MS);
        return;
      }
      if (possession.status === "failed") {
        possessionPoll = clearTimer(possessionPoll);
        ticker = clearTimer(ticker);
      }
      render();
    } catch (cause) {
      error = describe(cause);
      if (error.includes(VERIFICATION_REFUSAL)) error = VERIFICATION_REFUSAL;
      render();
    }
  };
  void poll();
  possessionPoll = window.setInterval(() => void poll(), POSSESSION_POLL_MS);
}

function syncPossessionSteps(state: PossessionProgress["status"]): void {
  if (state === "failed") return;
  const count = state === "online" ? 4 : state === "approved" ? 3 : state === "registered" ? 2 : 1;
  for (let index = 0; index < count; index += 1) completedSteps.add(index);
}

/**
 * Answer the permissions gate, and go back to watching the run either way.
 *
 * Not `guarded`, for one reason: it writes to `error`, and the possession poll
 * underneath this screen clears `error` on every tick — so a failure would
 * flash and disappear. Everything else about it is the same shape.
 *
 * Neither answer is a dead end. The daemon releases as soon as the answer is
 * durable rather than waiting on the dialogs, so the run continues and the
 * poll carries the person to the done gate. If the answer cannot be delivered
 * at all, both buttons stay pressable with the reason above them — and the
 * daemon's own two-minute timeout means even doing nothing moves on.
 */
async function answerPermissions(prime: boolean): Promise<void> {
  busy = true;
  permissionsError = null;
  render();
  try {
    await invoke("answer_permissions", { prime });
    busy = false;
    setScreen("host");
  } catch (cause) {
    permissionsError = describe(cause);
    busy = false;
    render();
  }
}

async function approveHost(): Promise<void> {
  if (!runId) return;
  const result = await guarded(() => invoke<string>("approve_possession", { runId }));
  if (result === null) return;
  completedSteps.add(APPROVAL_STEP);
  waitStartedAt = Date.now();
  // Approved is the moment, and this is the only place that knows it: the
  // gate is something the app creates between approving and waiting for
  // Online, not a state the daemon reports back. Asking also *holds* the
  // daemon, so it is asked once and only where the answer can be given. A
  // build whose daemon has no gate — or one that has already been answered —
  // says no, and the run carries straight on to Online.
  const gate = await invoke<boolean>("begin_permissions_gate").catch((cause) => {
    console.warn("permissions gate unavailable:", describe(cause));
    return false;
  });
  if (gate) {
    permissionsError = null;
    setScreen("permissions");
  }
}

/* ── Menu-bar surfaces ────────────────────────────────────────────────── */

async function refreshStatus(includeDoctor: boolean): Promise<void> {
  if (statusLoading) return;
  statusLoading = true;
  try {
    status = await invoke<LocalStatus>("local_status", { includeDoctor });
  } catch (cause) {
    error = describe(cause);
  } finally {
    statusLoading = false;
    render();
  }
}

/**
 * Ask the signed app channel what it has.
 *
 * Not `guarded`: this runs on its own on a screen that is already reporting
 * one problem, and a channel that cannot be reached is a second line of prose
 * there, not a red alert over the first. `updateCheck` is what the screens
 * read, so they can each say it in their own voice.
 */
async function checkUpdate(): Promise<void> {
  if (updateCheck === "checking") return;
  updateCheck = "checking";
  render();
  try {
    appUpdate = await invoke<AppUpdate>("check_app_update");
    updateCheck = "done";
  } catch (cause) {
    updateCheck = "failed";
    console.warn("app update check failed:", describe(cause));
  }
  render();
}

function stopPolls(): void {
  verifyPoll = clearTimer(verifyPoll);
  devicePoll = clearTimer(devicePoll);
}

/* ── Start ────────────────────────────────────────────────────────────── */

async function initialize(): Promise<void> {
  preferences = await invoke<Preferences>("app_preferences");
  terminalCommand = await invoke<string>("terminal_install_command");
  serverChoice = preferences.server_origin === HOSTED_ORIGIN ? "hosted" : "self";
  await listen<{ index: number }>("possess-step", (event) => {
    completedSteps.add(event.payload.index);
    render();
  });
  await listen<string>("tray-surface", (event) => {
    const surface = event.payload;
    if (surface === "update") {
      setScreen("update");
      void checkUpdate();
      return;
    }
    setScreen(surface === "repair" ? "repair" : surface === "quit" ? "quit" : "settings");
    void refreshStatus(surface === "repair");
  });
  await onOpenUrl((urls) => {
    for (const url of urls) void handleDeepLink(url);
  });

  // The move out of the keychain (`storage.rs`) is deliberately not announced
  // here. It cannot know whether macOS will actually ask — finding that out
  // means probing the keychain, which *is* the dialog — so a screen would have
  // shown to everyone while only builds whose signature changed ever see a
  // prompt. The sweep runs from the Rust `setup` hook at launch, so nothing
  // here needs to call it.
  if (preferences.first_run_complete) {
    // The window is only the wizard here because the tray asked for one of
    // its surfaces by name while the product had it; the hash says which.
    const requested = window.location.hash.slice(1) as Screen;
    screen = SURFACES.has(requested) ? requested : "settings";
    render();
    if (screen === "update") {
      await checkUpdate();
    } else {
      await refreshStatus(screen === "repair");
      void checkUpdate();
    }
  } else if (preferences.account_id) {
    // Signed in but not finished: pick the gate up where it was left, from
    // what the server says rather than from anything remembered locally.
    render();
    await loadConfig(true);
    try {
      const state = await invoke<AccountState>("account_state");
      emailVerified = state.email_verified;
      deviceGateRequired = !preferences.device_approved;
      await advance();
    } catch (cause) {
      await invoke("sign_out").catch(() => undefined);
      preferences = await invoke<Preferences>("app_preferences");
      setScreen("auth");
      error = `Sign in again to continue (${describe(cause)}).`;
      render();
    }
  } else {
    render();
    await loadConfig();
  }

  for (const url of (await getCurrent()) ?? []) void handleDeepLink(url);

  window.setInterval(() => {
    if (preferences.first_run_complete && screen === "settings") void refreshStatus(false);
  }, STATUS_REFRESH_MS);
  window.setInterval(() => {
    if (preferences.account_id) void invoke("renew_session").catch(() => undefined);
  }, SESSION_RENEW_MS);
}

void initialize().catch((cause) => {
  error = describe(cause);
  render();
});
