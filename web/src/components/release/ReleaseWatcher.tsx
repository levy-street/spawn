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
          {stalePrompt === "hard" && (
            <p className="pt-2 text-xs font-medium tabular-nums text-foreground" role="status">
              Reloading in {seconds} s…
            </p>
          )}
        </DialogHeader>
        <DialogFooter>
          {stalePrompt === "soft" && (
            <Button type="button" variant="outline" size="sm" onClick={snooze}>
              Later
            </Button>
          )}
          <Button type="button" size="sm" onClick={() => void reloadClient()}>
            Reload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
