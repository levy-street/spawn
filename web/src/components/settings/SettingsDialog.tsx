"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { MonitorSmartphone, Palette, ShieldCheck, User, Wrench, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentType } from "react";
import { AccountPanel } from "@/components/settings/AccountPanel";
import { AppearancePanel } from "@/components/settings/AppearancePanel";
import { DevicesPanel } from "@/components/settings/DevicesPanel";
import { SkillsPanel } from "@/components/settings/SkillsPanel";
import {
  closeSettings,
  openSettings,
  type SettingsTab,
  useSettingsDialog,
} from "@/components/settings/settings-dialog-store";
import { TrustPanel } from "@/components/settings/TrustPanel";
import { cn } from "@/lib/utils";

const TABS: Array<{
  key: SettingsTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { key: "account", label: "Account", icon: User },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "devices", label: "Browser devices", icon: MonitorSmartphone },
  { key: "trust", label: "Device trust", icon: ShieldCheck },
  { key: "skills", label: "Skills", icon: Wrench },
];

/**
 * App-wide settings modal: a left tab rail on desktop, a horizontal tab strip
 * on mobile, one scrolling content pane. Mounted once in AppShell and driven
 * by the settings-dialog store, so any surface can open any tab in place.
 */
export function SettingsDialog() {
  const tab = useSettingsDialog();
  const pathname = usePathname();
  const router = useRouter();

  const close = () => {
    closeSettings();
    // The /settings and /trust deep-link routes are empty shells that exist
    // only to open this dialog; closing it there would strand the user on a
    // blank page, so leave for the dashboard.
    if (pathname === "/settings" || pathname === "/trust") router.replace("/");
  };

  return (
    <Dialog.Root open={tab !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="settings-dialog"
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-background focus:outline-none",
            // Mobile: full screen. Desktop: a centered, bounded panel.
            "inset-0 pad-safe-top pad-safe-bottom",
            "md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(100vh-4rem,680px)] md:w-[min(100vw-3rem,920px)] md:-translate-x-1/2 md:-translate-y-1/2",
            "md:flex-row md:rounded-xl md:border md:border-border md:shadow-2xl md:shadow-black/20 md:dark:shadow-black/50",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 md:data-[state=open]:zoom-in-95",
          )}
        >
          <Dialog.Description className="sr-only">
            Account, appearance, browser devices, device trust, and skills.
          </Dialog.Description>

          {/* Tab rail: left column on desktop, horizontal strip on mobile. */}
          <nav
            aria-label="Settings sections"
            className={cn(
              // Mobile strip leaves room for the absolute close button.
              "flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card p-2 pr-12",
              "md:w-52 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r md:p-3",
            )}
          >
            {/* The rail label doubles as the dialog's accessible title; on
                mobile it is display:none but still names the dialog. */}
            <Dialog.Title asChild>
              <h2 className="hidden px-2 pb-2 pt-1 text-sm font-semibold md:block">Settings</h2>
            </Dialog.Title>
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => openSettings(key)}
                aria-current={tab === key ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  tab === key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="whitespace-nowrap">{label}</span>
              </button>
            ))}
          </nav>

          {/* Content pane. Keeps the @container/settings name the extracted
              panels' container-query variants were written against. */}
          <div className="@container/settings min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 pt-5 md:p-6">
              {tab === "account" && <AccountPanel />}
              {tab === "appearance" && <AppearancePanel />}
              {tab === "devices" && <DevicesPanel />}
              {tab === "trust" && <TrustPanel />}
              {tab === "skills" && <SkillsPanel />}
            </div>
          </div>

          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close settings"
              className="absolute right-3 top-3 mt-[env(safe-area-inset-top)] rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:bg-card/90 max-md:shadow-sm max-md:backdrop-blur md:mt-0"
            >
              <X className="size-4" />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
