"use client";

import { useQuery } from "@tanstack/react-query";
import { Menu, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { AccessCeremonyHost } from "@/components/access/ceremony-host";
import { HostGossipSync } from "@/components/access/host-gossip-sync";
import { SessionApprovalGate } from "@/components/access/session-approval-gate";
import { BrowserDeviceRegistrationStatus } from "@/components/auth/BrowserDeviceRegistrationStatus";
import { AddMachineDialog } from "@/components/hosts/AddMachineDialog";
import { HostLimitReconciliation } from "@/components/hosts/host-limit-reconciliation";
import { HostPinUndeliveredAlerts } from "@/components/hosts/host-pin-undelivered-alerts";
import { Wordmark } from "@/components/icons/BrandMark";
import { Sidebar } from "@/components/nav/Sidebar";
import { WorkspaceCarryOverlay } from "@/components/nav/workspace-carry";
import { ProfileDialog } from "@/components/profile/ProfileDialog";
import { HostUpdateNotifier } from "@/components/release/HostUpdateNotifier";
import { BillingReturnHandler } from "@/components/settings/billing-return";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { DeviceApprovalPrompt } from "@/components/trust/DeviceApprovalPrompt";
import { Button } from "@/components/ui/button";
import { ConfirmHost } from "@/components/ui/confirm";
import { Drawer } from "@/components/ui/drawer";
import { ToastHost } from "@/components/ui/toast";
import { NewSessionMenu } from "@/components/workspace/new-session-menu";
import { useLiveData } from "@/hooks/useLiveData";
import { useSessionAlerts } from "@/hooks/useSessionAlerts";
import { workspaces } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const SIDEBAR_MIN_WIDTH = 216;
const SIDEBAR_MAX_WIDTH = 420;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

/**
 * The sidebar's shape, remembered for the length of the tab.
 *
 * Every page mounts its own AppShell, and the router remounts one whenever a
 * route segment changes — switching workspaces included. Starting from the
 * component's own defaults each time means the rail flashes open (and writes
 * "expanded" back over the stored value) on the way to reading localStorage,
 * so the first read seeds this module and every later mount starts where the
 * last one left off. localStorage is still what survives a reload.
 */
const remembered: { collapsed: boolean | null; width: number | null } = {
  collapsed: null,
  width: null,
};

export function AppShell({
  children,
  hideMobileNav = false,
  mainClassName,
}: {
  children: ReactNode;
  hideMobileNav?: boolean;
  mainClassName?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(remembered.width);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(remembered.collapsed ?? false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [transitionReady, setTransitionReady] = useState(false);

  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspaces.list(),
    staleTime: 30_000,
  });
  /*
   * Alerts are mounted here because this is the one component every signed-in
   * route renders. The hook holds no state of its own — the socket, the
   * preferences and the cross-tab claim are all module singletons — precisely
   * because this shell remounts on every route change (see `remembered`
   * above), and an attention stream that redialed on every workspace click
   * would drop the events it exists to deliver.
   */
  useSessionAlerts();
  // The same socket also carries data-changed frames; this turns them into
  // cache invalidations so every open client shows the same account.
  useLiveData();
  const { user } = useAuth();
  const currentWorkspaceId = /^\/w\/([^/?]+)/u.exec(pathname)?.[1] ?? null;
  const currentWorkspaceName = useMemo(
    () => workspacesQ.data?.find((workspace) => workspace.id === currentWorkspaceId)?.name,
    [currentWorkspaceId, workspacesQ.data],
  );

  useIsoLayoutEffect(() => {
    // Only the first mount reads storage; after that `remembered` is the
    // fresher of the two — a mid-session toggle is in it before it is in
    // localStorage's next write.
    if (remembered.collapsed !== null) return;
    const savedWidth = Number(window.localStorage.getItem("spawn.sidebar.width"));
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      setSidebarWidth(clampSidebarWidth(savedWidth));
    }
    setSidebarCollapsed(window.localStorage.getItem("spawn.sidebar.collapsed") === "true");
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setTransitionReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (sidebarWidth !== null) {
      remembered.width = sidebarWidth;
      window.localStorage.setItem("spawn.sidebar.width", String(sidebarWidth));
    }
  }, [sidebarWidth]);

  useEffect(() => {
    remembered.collapsed = sidebarCollapsed;
    window.localStorage.setItem("spawn.sidebar.collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    // Reading the route is intentional: the drawer must close even when the
    // navigation came from browser history rather than a sidebar link.
    void pathname;
    setMobileSidebarOpen(false);
  }, [pathname]);

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width;
    if (!startWidth) return;
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setResizing(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
  };

  const navigateToCreated = ({
    workspaceId,
    sessionId,
  }: {
    workspaceId: string;
    sessionId: string | null;
  }) => {
    router.push(sessionId ? `/w/${workspaceId}?focus=${sessionId}` : `/w/${workspaceId}`);
  };

  return (
    /*
     * The sidebar is chrome and runs full-bleed; the content is a panel that
     * floats on it, inset by --content-inset with its own border and radius.
     * `<main>` raises the inset itself rather than the root doing it: an
     * element cannot container-query the container it establishes, so the
     * @md/shell variant only resolves on descendants. Keeping it there also
     * keeps it 0 on mobile, where the panel is edge to edge and the gap would
     * only cost width, and lets everything under main inherit the value for
     * its own --vv-height math.
     */
    <div className="@container/shell min-h-vv bg-shell">
      <div className="flex min-h-vv">
        <aside
          data-collapsed={sidebarCollapsed}
          style={{
            width: sidebarCollapsed
              ? "var(--sidebar-rail-width)"
              : sidebarWidth === null
                ? "var(--sidebar-width)"
                : `${sidebarWidth}px`,
          }}
          className={cn(
            // `sticky`, not `relative`: both were set, and which one won came down
            // to utility order in the generated stylesheet rather than intent.
            // Sticky already establishes the positioning context the resize
            // grip needs, so the pair collapses to the one that was meant.
            "pad-safe-top pad-safe-bottom sticky top-0 hidden h-vv shrink-0 flex-col bg-shell @md/shell:flex",
            transitionReady && !resizing && "transition-[width] duration-200 ease-swift",
          )}
          aria-label="Primary"
        >
          <Sidebar
            pathname={pathname}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((value) => !value)}
          />
          {!sidebarCollapsed && (
            <button
              type="button"
              aria-label="Resize sidebar"
              title="Resize sidebar"
              onPointerDown={startSidebarResize}
              className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize @md/shell:block"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors hover:bg-ring/60" />
            </button>
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <BrowserDeviceRegistrationStatus />
          {!hideMobileNav && (
            <header className="pad-safe-top pad-safe-x sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur @md/shell:hidden">
              <div className="grid h-12 grid-cols-[2.5rem_1fr_2.5rem] items-center px-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Open sidebar"
                  onClick={() => setMobileSidebarOpen(true)}
                  className="size-9"
                >
                  <Menu className="size-4.5" aria-hidden />
                </Button>
                <div className="min-w-0 px-2 text-center text-sm font-medium">
                  {currentWorkspaceName ? (
                    <span className="block truncate">{currentWorkspaceName}</span>
                  ) : (
                    // Centred by its own flex line, not the text baseline it
                    // would otherwise sit on, and in the same brand ink as
                    // the trident in the sidebar.
                    <span className="flex items-center justify-center text-hellfire">
                      <Wordmark className="h-3.5" />
                    </span>
                  )}
                </div>
                <NewSessionMenu
                  mode={currentWorkspaceId ? "session" : "workspace"}
                  workspaceId={currentWorkspaceId ?? undefined}
                  onCreated={navigateToCreated}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={currentWorkspaceId ? "Add session" : "New workspace"}
                      className="size-9"
                    >
                      <Plus className="size-4.5" aria-hidden />
                    </Button>
                  }
                />
              </div>
            </header>
          )}

          <main
            className={cn(
              "min-h-0 flex-1 pad-safe-x bg-background",
              "@md/shell:[--content-inset:8px] @md/shell:my-(--content-inset) @md/shell:mr-(--content-inset)",
              "@md/shell:overflow-hidden @md/shell:rounded-xl",
              mainClassName,
            )}
          >
            {children}
          </main>
        </div>
      </div>

      {!hideMobileNav && (
        <Drawer
          open={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
          ariaLabel="Primary navigation"
          contentClassName="overflow-hidden"
        >
          <Sidebar
            pathname={pathname}
            collapsed={false}
            onToggle={() => setMobileSidebarOpen(false)}
            onNavigate={() => setMobileSidebarOpen(false)}
            showCollapseControl={false}
          />
        </Drawer>
      )}
      {/* One overlay for the whole app, not one per surface that can start a
          carry: a workspace can be picked up from the rail, from the drawer's
          copy of it, or off its own name in a split's tab strip, and all three
          draw the same ghost over the same canvas. */}
      <WorkspaceCarryOverlay />
      <ConfirmHost />
      <ToastHost />
      <HostUpdateNotifier />
      <SettingsDialog />
      <AddMachineDialog />
      <BillingReturnHandler />
      <ProfileDialog />
      <AccessCeremonyHost />
      <SessionApprovalGate />
      <HostGossipSync />
      <DeviceApprovalPrompt accountId={user?.id ?? null} />
      <HostPinUndeliveredAlerts enabled={user !== null} />
      {/* Last, and app-wide on purpose: an account holding more machines than
          its plan admits must answer for that wherever it lands, and this is
          the only mount point every product route shares. It renders nothing
          at all on a deployment without billing, or on an account inside its
          limit (docs/BILLING.md §5.7). */}
      <HostLimitReconciliation />
    </div>
  );
}
