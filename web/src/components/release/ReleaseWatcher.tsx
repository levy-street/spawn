"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { clientBuildId, fetchRelease, webIsStale } from "@/lib/release";

type StalePrompt = "none" | "soft" | "hard";

const CHECK_INTERVAL_MS = 5 * 60_000;
const SNOOZE_MS = 30 * 60_000;
const SNOOZE_KEY = "spawn.release.snoozedUntil";

let prompt: StalePrompt = "none";
let checkTimer: number | null = null;
let checkInFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: StalePrompt): void {
  if (prompt === "hard" || prompt === next) return;
  prompt = next;
  for (const listener of listeners) listener();
}

function snoozed(): boolean {
  try {
    const until = Number(window.sessionStorage.getItem(SNOOZE_KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function checkRelease(): Promise<void> {
  if (checkInFlight) return checkInFlight;
  checkInFlight = fetchRelease()
    .then((release) => {
      if (prompt === "hard") return;
      const stale = webIsStale({
        clientBuildId: clientBuildId(),
        serverBuildId: release.web.build_id,
      });
      if (stale && !snoozed()) publish("soft");
      else if (!stale && prompt === "soft") publish("none");
    })
    .catch(() => {
      // A public release check is advisory on the soft path. Login, local
      // development, and a server mid-restart must keep working normally.
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void checkRelease();
}

function onClientStale(event: Event): void {
  const hard = event instanceof CustomEvent && event.detail?.hard === true;
  if (hard) {
    publish("hard");
    return;
  }
  void checkRelease();
}

function startScheduler(): void {
  if (typeof window === "undefined" || checkTimer !== null) return;
  void checkRelease();
  checkTimer = window.setInterval(() => void checkRelease(), CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", checkRelease);
  window.addEventListener("spawn:client-stale", onClientStale);
}

function stopScheduler(): void {
  if (typeof window === "undefined" || checkTimer === null) return;
  window.clearInterval(checkTimer);
  checkTimer = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("online", checkRelease);
  window.removeEventListener("spawn:client-stale", onClientStale);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startScheduler();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopScheduler();
  };
}

function getPrompt(): StalePrompt {
  return prompt;
}

function snooze(): void {
  try {
    window.sessionStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    // A privacy mode may deny storage. Dismissing for this render is still
    // better than making Later inert; the next scheduled check can ask again.
  }
  prompt = "none";
  for (const listener of listeners) listener();
}

async function reloadClient(): Promise<void> {
  try {
    await navigator.serviceWorker?.getRegistration().then((registration) => registration?.update());
  } catch {
    // Best effort: a normal reload still moves the tab to the deployed build.
  }
  window.location.reload();
}

/** One tab-wide release prompt. Its scheduler is module-owned so React strict
 * mode cannot leave a duplicate five-minute timer behind. */
export function ReleaseWatcher() {
  const stalePrompt = useSyncExternalStore(subscribe, getPrompt, () => "none");
  const [seconds, setSeconds] = useState(10);

  useEffect(() => {
    if (stalePrompt !== "hard") return;
    setSeconds(10);
    const timer = window.setInterval(() => {
      setSeconds((current) => {
        if (current > 1) return current - 1;
        window.clearInterval(timer);
        void reloadClient();
        return 0;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [stalePrompt]);

  if (stalePrompt === "none") return null;

  // A hard prompt is not a suggestion. It only ever comes from the server
  // refusing this client at the handshake — `protocol.required`, the
  // fleet-wide cutover in docs/RELEASE.md — which means this tab genuinely
  // cannot talk to the server any more. There is nothing to weigh up and no
  // "later" that works, so it takes the whole screen and gets on with it.
  if (stalePrompt === "hard") {
    return <ForcedUpdateOverlay seconds={seconds} />;
  }

  return (
    <Dialog open>
      <DialogContent
        size="sm"
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>SPAWN D has been updated</DialogTitle>
          <DialogDescription>
            Reload to pick up the new version. Open terminals reconnect on their own.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={snooze}>
            Later
          </Button>
          <Button type="button" size="sm" onClick={() => void reloadClient()}>
            Reload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The whole screen, while a required update is taken.
 *
 * This is the one update the person does not get to decline. It appears only
 * on a protocol refusal: the server has closed the socket saying it will not
 * speak this client's version, so every other surface in the app is already
 * dead — a dismissible notice over a broken app would be a lie about what
 * still works.
 *
 * It is deliberately not a Dialog. A dialog implies something behind it that
 * you could go back to, and there isn't.
 *
 * The bar is time against the countdown, which is a real quantity — how long
 * until this tab reloads — rather than an invented download percentage.
 */
function ForcedUpdateOverlay({ seconds }: { seconds: number }) {
  const total = 10;
  const elapsed = Math.max(0, Math.min(total, total - seconds));
  const percent = Math.round((elapsed / total) * 100);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="forced-update-title"
      aria-describedby="forced-update-body"
      className="fixed inset-0 z-[200] grid place-items-center bg-background/95 p-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm text-center">
        <h2 id="forced-update-title" className="text-base font-medium text-foreground">
          SPAWN D needs to update
        </h2>
        <p id="forced-update-body" className="mt-2 text-sm text-muted-foreground">
          This version can no longer talk to the server. Updating now — open terminals reconnect on
          their own.
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-3 text-xs tabular-nums text-muted-foreground" role="status">
          Reloading in {seconds} s…
        </p>
        <Button type="button" size="sm" className="mt-5" onClick={() => void reloadClient()}>
          Reload now
        </Button>
      </div>
    </div>
  );
}
