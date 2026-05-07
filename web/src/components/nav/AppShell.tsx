"use client";

import { GripVertical, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";
import { AgentSidebar } from "@/components/nav/AgentSidebar";
import { BottomTabs, NAV } from "@/components/nav/BottomTabs";
import { Button } from "@/components/ui/button";
import { logout, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const SIDEBAR_DEFAULT_WIDTH = 248;
const SIDEBAR_MIN_WIDTH = 208;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_COLLAPSED_WIDTH = 64;

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
  const { user } = useAuth();
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    const savedWidth = Number(window.localStorage.getItem("spawn.sidebar.width"));
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      setSidebarWidth(clampSidebarWidth(savedWidth));
    }
    setSidebarCollapsed(window.localStorage.getItem("spawn.sidebar.collapsed") === "true");
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

    const onMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
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
          style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
          className={cn(
            "relative hidden shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 @md/shell:flex pad-safe-top pad-safe-bottom",
            sidebarCollapsed && "items-center",
          )}
          aria-label="Primary"
        >
          <div
            className={cn(
              "flex w-full items-center gap-2 px-4 py-4",
              sidebarCollapsed ? "justify-center px-2" : "justify-between",
            )}
          >
            {!sidebarCollapsed && <div className="text-lg font-semibold tracking-tight">spawn</div>}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setSidebarCollapsed((v) => !v)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="size-4" />
              ) : (
                <PanelLeftClose className="size-4" />
              )}
            </Button>
          </div>
          <nav className={cn("min-h-0 flex-1", sidebarCollapsed ? "px-1" : "px-2")}>
            <ul className="space-y-1">
              {NAV.map((item) => {
                const Icon = item.icon;
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={sidebarCollapsed ? item.label : undefined}
                      className={cn(
                        "flex items-center rounded-md text-sm transition-colors",
                        sidebarCollapsed ? "size-10 justify-center px-0 py-0" : "gap-2 px-3 py-2",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {!sidebarCollapsed && <span>{item.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
            <AgentSidebar pathname={pathname} collapsed={sidebarCollapsed} />
          </nav>
          <div
            className={cn(
              "w-full border-t border-border text-xs text-muted-foreground",
              sidebarCollapsed ? "p-2" : "p-3",
            )}
          >
            {!sidebarCollapsed && <div className="truncate">{user?.email ?? "—"}</div>}
            <Button
              variant="ghost"
              size={sidebarCollapsed ? "icon" : "sm"}
              className={cn(sidebarCollapsed ? "size-10" : "mt-2 w-full justify-start px-2")}
              aria-label="Log out"
              title={sidebarCollapsed ? "Log out" : undefined}
              onClick={() => {
                void logout();
              }}
            >
              {sidebarCollapsed ? <LogOut className="size-4" /> : "Log out"}
            </Button>
          </div>
          {!sidebarCollapsed && (
            <button
              type="button"
              aria-label="Resize sidebar"
              title="Resize sidebar"
              onPointerDown={startSidebarResize}
              className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:text-foreground @md/shell:flex"
            >
              <GripVertical className="size-3" />
            </button>
          )}
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
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
                size="sm"
                onClick={() => {
                  void logout();
                }}
              >
                Log out
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
    </div>
  );
}
