"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { AccessCeremonyHost } from "@/components/access/ceremony-host";
import { SessionApprovalGate } from "@/components/access/session-approval-gate";
import { BrowserDeviceRegistrationStatus } from "@/components/auth/BrowserDeviceRegistrationStatus";
import { BottomTabs } from "@/components/nav/BottomTabs";
import { SIDEBAR_RAIL_WIDTH, Sidebar } from "@/components/nav/Sidebar";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Runs before paint on the client, falls back to a no-op-ish effect on the
// server (avoids the useLayoutEffect SSR warning).
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const SIDEBAR_DEFAULT_WIDTH = 264;
const SIDEBAR_MIN_WIDTH = 216;
const SIDEBAR_MAX_WIDTH = 420;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

/**
 * Responsive shell: a left rail at >=md (container query), and a top bar +
 * bottom tab bar below that. The shell itself is a top-level container so
 * children can use `@md:` variants on container queries.
 */
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
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [resizing, setResizing] = useState(false);
  // Width transitions only after the first paint. AppShell remounts on
  // cross-route navigation, and applying the saved width would otherwise glide
  // from the default every time — jerking the terminal that resizes with it.
  const [transitionReady, setTransitionReady] = useState(false);

  // Apply the persisted width BEFORE paint so a remount snaps straight to the
  // saved size (no visible default frame, no glide).
  useIsoLayoutEffect(() => {
    const savedWidth = Number(window.localStorage.getItem("spawn.sidebar.width"));
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      setSidebarWidth(clampSidebarWidth(savedWidth));
    }
    setSidebarCollapsed(window.localStorage.getItem("spawn.sidebar.collapsed") === "true");
  }, []);

  // Enable the width transition one frame later, so collapse/drag still glide
  // but the initial saved-width application does not.
  useEffect(() => {
    const id = requestAnimationFrame(() => setTransitionReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("spawn.sidebar.width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem("spawn.sidebar.collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
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

  return (
    <div className="@container/shell min-h-vv">
      <div className="flex min-h-vv">
        {/* Side rail (desktop) */}
        <aside
          data-collapsed={sidebarCollapsed}
          style={{ width: sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth }}
          className={cn(
            "relative hidden h-vv shrink-0 flex-col border-r border-border bg-card @md/shell:flex pad-safe-top pad-safe-bottom",
            "sticky top-0",
            transitionReady && !resizing && "transition-[width] duration-200 ease-swift",
          )}
          aria-label="Primary"
        >
          <Sidebar
            pathname={pathname}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((v) => !v)}
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

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <BrowserDeviceRegistrationStatus />
          {/* Top bar (mobile only) */}
          <header
            className={cn(
              "@md/shell:hidden sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur pad-safe-top pad-safe-x",
              hideMobileNav && "hidden",
            )}
          >
            <div className="flex h-12 items-center justify-between px-4">
              <Link href="/" className="text-base font-semibold tracking-tight">
                spawn
              </Link>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Settings"
                onClick={() => openSettings("account")}
              >
                <Settings className="size-4.5" />
              </Button>
            </div>
          </header>

          <main
            className={cn(
              "@md/shell:pb-0 flex-1 pb-20 pad-safe-x",
              hideMobileNav && "pb-0",
              mainClassName,
            )}
          >
            {children}
          </main>
        </div>
      </div>
      {!hideMobileNav && <BottomTabs />}
      <SettingsDialog />
      <AccessCeremonyHost />
      <SessionApprovalGate />
    </div>
  );
}
