"use client";

import { Download, LayoutGrid, Server, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/dash", label: "Dash", icon: LayoutGrid },
  { href: "/hosts", label: "Hosts", icon: Server },
  { href: "/agents", label: "Agents", icon: Sparkles },
  { href: "/download", label: "Install", icon: Download },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function BottomTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="@md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur pad-safe-bottom"
    >
      <ul className="flex items-stretch justify-between px-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 px-2 py-2 text-[11px]",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon className="size-5" aria-hidden />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
