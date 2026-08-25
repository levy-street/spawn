"use client";

import {
  Bell,
  Bot,
  ExternalLink,
  LayoutTemplate,
  Palette,
  Server,
  ShieldCheck,
  User,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";
import { AccessPanel } from "@/components/settings/AccessPanel";
import { AccountPanel } from "@/components/settings/AccountPanel";
import { AgentsPanel } from "@/components/settings/AgentsPanel";
import { AppearancePanel } from "@/components/settings/AppearancePanel";
import { NotificationsPanel } from "@/components/settings/NotificationsPanel";
import { SkillsPanel } from "@/components/settings/SkillsPanel";
import {
  closeSettings,
  openSettings,
  type SettingsTab,
  useSettingsDialog,
} from "@/components/settings/settings-dialog-store";
import { TemplatesPanel } from "@/components/settings/TemplatesPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * Identity first, then the resources a workspace draws on, then Access —
 * which is the one tab about who may reach those resources at all, and so
 * reads as the floor under the rest rather than another resource beside them.
 * "Browser devices" and "Device trust" were two tabs before the mesh; both
 * now live on Access (docs/TRUST_UX.md).
 */
const TABS: Array<{
  key: SettingsTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { key: "account", label: "Account", icon: User },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "skills", label: "Skills", icon: Wrench },
  { key: "templates", label: "Templates", icon: LayoutTemplate },
  { key: "access", label: "Access", icon: ShieldCheck },
];

export function SettingsDialog() {
  const tab = useSettingsDialog();
  const { user } = useAuth();

  return (
    <Dialog open={tab !== null} onOpenChange={(open) => (open ? undefined : closeSettings())}>
      <DialogContent size="full-mobile" data-testid="settings-dialog" className="md:flex-row">
        <DialogDescription className="sr-only">
          Manage your account, appearance, notifications, agents, skills, templates, and access.
        </DialogDescription>

        <nav
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card p-2 pr-12 md:w-52 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r md:p-3"
        >
          <DialogTitle className="hidden px-2 pb-2 pt-1 text-sm font-semibold md:block">
            Settings
          </DialogTitle>
          {TABS.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openSettings(key)}
              aria-current={tab === key ? "page" : undefined}
              className={cn(
                "h-9 shrink-0 justify-start px-2.5",
                tab === key
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="whitespace-nowrap">{label}</span>
            </Button>
          ))}
          {user?.is_admin && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="h-9 shrink-0 justify-start px-2.5 text-muted-foreground md:mt-auto"
            >
              <Link href="/admin" onClick={closeSettings}>
                <ExternalLink className="size-4 shrink-0" aria-hidden />
                <span className="whitespace-nowrap">Admin</span>
              </Link>
            </Button>
          )}
        </nav>

        <div className="@container/settings min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pt-5 md:p-6">
            {tab === "account" && <AccountPanel />}
            {tab === "appearance" && <AppearancePanel />}
            {tab === "notifications" && <NotificationsPanel />}
            {tab === "agents" && <AgentsPanel />}
            {tab === "skills" && <SkillsPanel />}
            {tab === "templates" && <TemplatesPanel />}
            {tab === "access" && <AccessPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
