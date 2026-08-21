"use client";

import type { AlertEventKind } from "@/lib/alerts";

/**
 * The four ways an alert can reach a person, and an honest account of which
 * of them this browser can actually do.
 *
 * The honesty matters more than the delivery. Every one of these channels
 * fails silently when it is unavailable — a `vibrate()` that no-ops, a
 * `Notification` that never appears because Safari only delivers to an
 * installed PWA — and a toggle that looks on while doing nothing is worse
 * than a toggle that explains itself.
 */

export type SystemPermission = "unsupported" | "default" | "granted" | "denied";

export interface ChannelSupport {
  sound: boolean;
  haptics: boolean;
  system: SystemPermission;
  /** iOS delivers web notifications only to a home-screen install. */
  needsInstall: boolean;
  standalone: boolean;
}

/**
 * Pure classifier for the system-notification channel, so the awkward part —
 * iOS needing an install before the API means anything — is testable without
 * a browser.
 */
export function classifySystemChannel(input: {
  hasNotification: boolean;
  permission: NotificationPermission | null;
  isIOS: boolean;
  standalone: boolean;
}): { system: SystemPermission; needsInstall: boolean } {
  // Safari exposes no Notification constructor in a normal iOS tab, and only
  // exposes one inside a standalone install. Report the install requirement
  // rather than a bare "unsupported", which reads as "never going to work".
  if (input.isIOS && !input.standalone) {
    return { system: "unsupported", needsInstall: true };
  }
  if (!input.hasNotification || input.permission === null) {
    return { system: "unsupported", needsInstall: false };
  }
  return { system: input.permission, needsInstall: false };
}

export function isIOSBrowser(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  // iPadOS reports a desktop Mac UA; touch points are what give it away.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    // matchMedia can throw in exotic embedders; the navigator flag still works.
  }
  return (window.navigator as { standalone?: boolean }).standalone === true;
}

export function channelSupport(): ChannelSupport {
  if (typeof window === "undefined") {
    return {
      sound: false,
      haptics: false,
      system: "unsupported",
      needsInstall: false,
      standalone: false,
    };
  }
  const standalone = isStandaloneDisplay();
  const { system, needsInstall } = classifySystemChannel({
    hasNotification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : null,
    isIOS: isIOSBrowser(window.navigator.userAgent, window.navigator.maxTouchPoints ?? 0),
    standalone,
  });
  return {
    sound:
      typeof window.AudioContext !== "undefined" ||
      typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined",
    haptics: "vibrate" in window.navigator,
    system,
    needsInstall,
    standalone,
  };
}

// --- sound -----------------------------------------------------------------

let audioContext: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

/**
 * Arm the sound channel from inside a user gesture.
 *
 * Autoplay policy will not let a page make noise until it has been
 * interacted with, and the only guaranteed gesture in this feature's life is
 * the click that turns the toggle on. Arming lazily at the first alert means
 * the first alert — the one someone is sitting there testing — is silent.
 */
export async function armSound(): Promise<boolean> {
  const Ctor = audioContextCtor();
  if (!Ctor) return false;
  try {
    audioContext ??= new Ctor();
    if (audioContext.state === "suspended") await audioContext.resume();
    return audioContext.state === "running";
  } catch {
    return false;
  }
}

/**
 * A short two-note cue, synthesized rather than shipped.
 *
 * No asset: nothing to cache, nothing to 404, nothing to add to the bundle,
 * and the shape can carry meaning — finishing rises, dying falls — which one
 * bundled blip could not.
 */
export function playAlertCue(kind: AlertEventKind): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  try {
    audioContext ??= new Ctor();
    const ctx = audioContext;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    // Rising = done, falling = gone, and a soft double for "your turn".
    const notes =
      kind === "session.died"
        ? [660, 440]
        : kind === "agent.awaiting_input"
          ? [780, 780]
          : [660, 880];
    notes.forEach((frequency, index) => {
      const start = now + index * 0.11;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(frequency, start);
      // A tiny attack and an exponential tail: a raw gate on a sine clicks.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.12);
    });
  } catch {
    // A cue is a courtesy; never let it reach the caller.
  }
}

// --- haptics ---------------------------------------------------------------

export function vibrateAlert(kind: AlertEventKind): void {
  if (typeof window === "undefined" || !("vibrate" in window.navigator)) return;
  try {
    window.navigator.vibrate(kind === "session.died" ? [70, 60, 70] : [40, 60, 40]);
  } catch {
    // Some embedders throw rather than returning false.
  }
}

// --- system notification ---------------------------------------------------

export async function requestSystemPermission(): Promise<SystemPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    // Permission is one-shot per origin, which is why this is only ever
    // called from an explicit button and never on load.
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Show an OS notification, preferring the service worker registration.
 *
 * `new Notification()` throws on Android Chrome and does nothing useful in an
 * installed PWA; `registration.showNotification` is the path that works
 * everywhere and the only one whose click can be routed by `sw.js`.
 */
export async function showSystemAlert(options: {
  title: string;
  body: string;
  tag: string;
  url: string;
  silent: boolean;
}): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  const payload: NotificationOptions = {
    body: options.body,
    tag: options.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // The sound channel owns audio; letting the OS chime too double-alerts
    // anyone who turned both on.
    silent: options.silent,
    data: { url: options.url },
  };
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration) {
      await registration.showNotification(options.title, payload);
      return true;
    }
  } catch {
    // No worker (dev, or registration failed): fall through to the
    // constructor, which is enough on desktop.
  }
  try {
    const notification = new Notification(options.title, payload);
    notification.onclick = () => {
      window.focus();
      window.location.href = options.url;
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
