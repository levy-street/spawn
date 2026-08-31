"use client";

import {
  Bell,
  Bot,
  CreditCard,
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
import { SubscriptionPanel } from "@/components/settings/SubscriptionPanel";
import {
  closeSettings,
  openSettings,
  type SettingsTab,
  useSettingsDialog,
} from "@/components/settings/settings-dialog-store";
import { TemplatesPanel } from "@/components/settings/TemplatesPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useBilling } from "@/hooks/useBilling";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

interface SettingsTabDef {
  key: SettingsTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Identity first — the account, and then what it pays for, which is a fact
 * about the account and not a resource — then the resources a workspace draws
 * on, then Access, which is the one tab about who may reach those resources at
 * all and so reads as the floor under the rest rather than another resource
 * beside them. "Browser devices" and "Device trust" were two tabs before the
 * mesh; both now live on Access (docs/TRUST_UX.md).
 */
const TABS: SettingsTabDef[] = [
  { key: "account", label: "Account", icon: User },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "notifications", label: "Notifications", icon: Bell },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "skills", label: "Skills", icon: Wrench },
  { key: "templates", label: "Templates", icon: LayoutTemplate },
  { key: "access", label: "Access", icon: ShieldCheck },
];

const SUBSCRIPTION_TAB: SettingsTabDef = {
  key: "subscription",
  label: "Subscription",
  icon: CreditCard,
};

export function SettingsDialog() {
  const tab = useSettingsDialog();
  const { user } = useAuth();
  // A deployment with no billing has no Subscription tab at all — a
  // self-hoster sees exactly the seven they saw before this existed
  // (docs/BILLING.md §5.3).
  const { enabled: billingEnabled } = useBilling();
  const tabs = billingEnabled ? [TABS[0], SUBSCRIPTION_TAB, ...TABS.slice(1)] : TABS;
  // A stale deep link, or a client that asked for the tab before the config
  // arrived, must not land on a blank panel.
  const active = tab === "subscription" && !billingEnabled ? "account" : tab;

  return (
    <Dialog open={tab !== null} onOpenChange={(open) => (open ? undefined : closeSettings())}>
      <DialogContent size="full-mobile" data-testid="settings-dialog" className="md:flex-row">
        {/* Enumerates the sections, so it has to track the tab list — a
            screen reader hearing six of seven is being lied to. */}
        <DialogDescription className="sr-only">
          {billingEnabled
            ? "Manage your account, subscription, appearance, notifications, agents, skills, templates, and access."
            : "Manage your account, appearance, notifications, agents, skills, templates, and access."}
        </DialogDescription>

        <nav
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card p-2 pr-12 md:w-52 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r md:p-3"
        >
          <DialogTitle className="hidden px-2 pb-2 pt-1 text-sm font-semibold md:block">
            Settings
          </DialogTitle>
          {tabs.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => openSettings(key)}
              aria-current={active === key ? "page" : undefined}
              className={cn(
                "h-9 shrink-0 justify-start px-2.5",
                active === key
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
            {active === "account" && <AccountPanel />}
            {active === "subscription" && <SubscriptionPanel />}
            {active === "appearance" && <AppearancePanel />}
            {active === "notifications" && <NotificationsPanel />}
            {active === "agents" && <AgentsPanel />}
            {active === "skills" && <SkillsPanel />}
            {active === "templates" && <TemplatesPanel />}
            {active === "access" && <AccessPanel />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
