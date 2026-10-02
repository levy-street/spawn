"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SquareDashed } from "lucide-react";
import { isValidElement, type JSX, useRef } from "react";
import {
  CascadeMenu,
  type CascadeMenuHandle,
  type CascadePanel,
} from "@/components/ui/cascade-menu";
import { toast } from "@/components/ui/toast";
import { type Host, type WorkspaceTemplate, workspaces, workspaceTemplates } from "@/lib/api";
import { instantiateTemplate } from "./instantiate-template";
import { useWherePanel } from "./where-picker";

/**
 * The "New workspace" dropdown: a blank workspace, or one of the saved
 * templates. A workspace has no host or folder of its own — each window says
 * where it runs — so a blank one is made at once and asks nothing; a template
 * asks once where its windows run, likeliest place first.
 */
export function NewWorkspaceMenu({
  trigger,
  onCreated,
}: {
  trigger: React.ReactNode;
  onCreated?: (result: { workspaceId: string; focusSessionId: string | null }) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  // The cascade has closed by the time the folder browser opens, so it hangs
  // off the trigger the cascade came from instead.
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<CascadeMenuHandle>(null);
  const templatesQ = useQuery({
    queryKey: ["workspace-templates"],
    queryFn: workspaceTemplates.list,
    staleTime: 30_000,
  });
  const where = useWherePanel({ anchorRef: triggerRef, onBack: () => menuRef.current?.open() });

  const settle = (result: { workspaceId: string; focusSessionId: string | null }) => {
    queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    onCreated?.(result);
  };
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : String(error));

  const blankM = useMutation({
    mutationFn: async () => {
      // Empty: one tab on its empty state. Booting a terminal nobody asked for
      // makes the first thing you do closing it.
      const result = await workspaces.create({});
      // The envelope the view is about to ask for is already in hand: seed it,
      // so the new workspace opens without a "Loading workspace" beat.
      queryClient.setQueryData(["workspace", result.workspace.id], result.workspace);
      return { workspaceId: result.workspace.id, focusSessionId: null };
    },
    onSuccess: settle,
    onError: fail,
  });
  const templateM = useMutation({
    mutationFn: ({
      template,
      host,
      cwd,
    }: {
      template: WorkspaceTemplate;
      host: Host;
      cwd: string;
    }) => instantiateTemplate(template, host, cwd),
    onSuccess: settle,
    onError: fail,
  });
  const busy = blankM.isPending || templateM.isPending;

  const templates = templatesQ.data ?? [];
  const root: CascadePanel = {
    id: "new-workspace",
    items: [
      {
        key: "blank",
        icon: <SquareDashed />,
        label: "Blank workspace",
        disabled: busy,
        onSelect: () => blankM.mutate(),
      },
      ...(templates.length > 0
        ? [{ key: "templates-heading", label: "Templates", heading: true }]
        : []),
      ...templates.map((template) => ({
        key: template.id,
        label: template.name,
        disabled: busy,
        panel: where.panel(`template-${template.id}`, (host, cwd) => {
          if (host.status === "online" && !busy) templateM.mutate({ template, host, cwd });
        }),
      })),
    ],
  };

  return (
    <>
      <CascadeMenu
        ref={menuRef}
        root={root}
        className="block w-full"
        menuClassName="w-64"
        sheetTitle="New workspace"
        renderTrigger={(triggerProps) =>
          isValidElement(trigger) ? (
            <Slot
              {...triggerProps}
              ref={triggerRef}
              aria-disabled={busy || undefined}
              onClick={busy ? undefined : triggerProps.onClick}
            >
              {trigger}
            </Slot>
          ) : (
            <button
              {...triggerProps}
              ref={(node) => {
                triggerRef.current = node;
              }}
              type="button"
            >
              {trigger as React.ReactNode}
            </button>
          )
        }
      />
      {where.overlays}
    </>
  );
}
