"use client";

import {
  BellRing,
  MessageCircleQuestion,
  MessageSquare,
  Skull,
  Smartphone,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SwitchRow } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { getAlertSocketState, subscribeToAlertSocketState } from "@/lib/alert-socket";
import {
  armSound,
  type ChannelSupport,
  channelSupport,
  playAlertCue,
  requestSystemPermission,
  vibrateAlert,
} from "@/lib/notify-channels";
import { useNotifyPrefs } from "@/lib/notify-prefs";

/**
 * Settings ▸ Notifications.
 *
 * The copy is doing as much work as the toggles. Three of these four channels
 * can be switched on and then silently do nothing — an iOS tab that is not an
 * installed PWA, a browser where notification permission was denied months
 * ago, a desktop with no vibration motor — and a toggle that lies is worse
 * than one that is missing. So every channel reports what it can actually do,
 * and the ones that cannot say so in place.
 */
export function NotificationsPanel() {
  const { prefs, setPref } = useNotifyPrefs();
  const [support, setSupport] = useState<ChannelSupport | null>(null);
  const [connected, setConnected] = useState(false);

  // Read capabilities in an effect: they touch navigator/Notification and
  // would not survive a server render.
  useEffect(() => setSupport(channelSupport()), []);

  useEffect(() => {
    const sync = () => setConnected(getAlertSocketState() === "open");
    sync();
    return subscribeToAlertSocketState(sync);
  }, []);

  const enableSound = useCallback(
    async (next: boolean) => {
      if (next) {
        // Arm inside the click. Autoplay policy will not let a page make
        // noise until it has been interacted with, and this is the gesture.
        const armed = await armSound();
        if (!armed) {
          toast.error("This browser blocked audio. Try again after clicking the page.");
          return;
        }
        playAlertCue("agent.finished");
      }
      setPref("sound", next);
    },
    [setPref],
  );

  const enableSystem = useCallback(
    async (next: boolean) => {
      if (!next) {
        setPref("system", false);
        return;
      }
      const permission = await requestSystemPermission();
      setSupport(channelSupport());
      if (permission !== "granted") {
        toast.error(
          permission === "denied"
            ? "Notifications are blocked for this site in your browser settings."
            : "Notification permission was not granted.",
        );
        return;
      }
      setPref("system", true);
    },
    [setPref],
  );

  const enableHaptics = useCallback(
    (next: boolean) => {
      if (next) vibrateAlert("agent.finished");
      setPref("haptics", next);
    },
    [setPref],
  );

  const systemBlocked = support?.system === "denied";
  const systemUnavailable = support?.system === "unsupported";

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold">Notifications</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Tells you when an agent finishes a run, so you can leave the machine and mean it. Alerts
          arrive the moment the host reports it — there is no polling in the path. These settings
          apply to this browser only.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Tell me when
        </h4>
        <SwitchRow
          checked={prefs.onFinished}
          onCheckedChange={(next) => setPref("onFinished", next)}
          label="An agent finishes"
          hint="The agent process exited and the shell is back. Crisp, but rarer than you would think — most coding agents stay running between turns."
          icon={<BellRing className="size-4" />}
        />
        <SwitchRow
          checked={prefs.onAwaiting}
          onCheckedChange={(next) => setPref("onAwaiting", next)}
          label="An agent is waiting for you"
          hint="A running agent stopped producing output — it finished its turn, or it is asking a permission question. The same moment its status dot turns amber. Coding agents idle at a prompt rather than exit, so this is usually the one you want."
          icon={<MessageCircleQuestion className="size-4" />}
        />
        <SwitchRow
          checked={prefs.onDied}
          onCheckedChange={(next) => setPref("onDied", next)}
          label="A session exits or is killed"
          hint="The shell itself went away — a crash, or a host that stopped."
          icon={<Skull className="size-4" />}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">How</h4>

        <SwitchRow
          checked={prefs.toast}
          onCheckedChange={(next) => setPref("toast", next)}
          label="In-app message"
          hint="A toast in the corner, while you are looking at the tab."
          icon={<MessageSquare className="size-4" />}
        />

        <SwitchRow
          checked={prefs.sound}
          onCheckedChange={(next) => void enableSound(next)}
          label="Sound"
          hint={
            support && !support.sound
              ? "This browser has no audio output available."
              : "A short cue. Turning this on plays it once so you know what to listen for."
          }
          disabled={support ? !support.sound : false}
          icon={<Volume2 className="size-4" />}
        />

        <SwitchRow
          checked={prefs.system && !systemBlocked}
          onCheckedChange={(next) => void enableSystem(next)}
          label="System notification"
          hint={
            systemUnavailable && support?.needsInstall ? (
              <>
                On iPhone and iPad this needs spawn added to your home screen — open the share menu
                and choose <span className="font-medium">Add to Home Screen</span>, then come back
                here.
              </>
            ) : systemUnavailable ? (
              "This browser does not support web notifications."
            ) : systemBlocked ? (
              "Blocked for this site. Allow notifications in your browser's site settings, then switch this back on."
            ) : (
              "Only while this tab is in the background, so a tab you are looking at never tells you twice."
            )
          }
          disabled={systemUnavailable || systemBlocked}
          icon={<BellRing className="size-4" />}
        />

        <SwitchRow
          checked={prefs.haptics}
          onCheckedChange={enableHaptics}
          label="Vibration"
          hint={
            support && !support.haptics
              ? "This device has no vibration API — Safari and most desktops do not implement it."
              : "A short buzz on the same events."
          }
          disabled={support ? !support.haptics : false}
          icon={<Smartphone className="size-4" />}
        />
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Alert stream</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {connected
                ? "Connected. Events arrive as they happen."
                : "Not connected — alerts will resume automatically."}
            </p>
          </div>
          <span
            className={`size-2 shrink-0 rounded-full ${connected ? "bg-tone-active" : "bg-tone-offline"}`}
            role="img"
            aria-label={connected ? "Connected" : "Disconnected"}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            if (prefs.sound) playAlertCue("agent.finished");
            if (prefs.haptics) vibrateAlert("agent.finished");
            if (prefs.toast) toast("Test alert — this is what a finished agent looks like.");
          }}
        >
          Send a test alert
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        To silence one noisy session without turning any of this off, use{" "}
        <span className="font-medium">Mute alerts</span> in that pane's menu. Closing every spawn
        tab stops alerts entirely — nothing is delivered to a browser that is not running.
      </p>
    </section>
  );
}
