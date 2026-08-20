"use client";

import { Slot } from "@radix-ui/react-slot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { isValidElement, type JSX, useState } from "react";
import { CascadeMenu, type CascadePanel } from "@/components/ui/cascade-menu";
import { hostStatusTone, StatusDot } from "@/components/ui/status";
import { toast } from "@/components/ui/toast";
import {
  type Host,
  hosts,
  type WorkspaceTemplate,
  workspaces,
  workspaceTemplates,
} from "@/lib/api";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { instantiateTemplate } from "./instantiate-template";

/** What the menu creates once a folder is chosen: a blank workspace with one
 *  shell, or a saved template replayed against the folder. */
type Choice = { kind: "blank" } | { kind: "template"; template: WorkspaceTemplate };

function choiceKey(choice: Choice): string {
  return choice.kind === "template" ? `template-${choice.template.id}` : "blank";
}

/**
 * The "New workspace" dropdown: pick a folder for a fresh workspace, or pick
 * one of the saved templates (then its folder). Both flows end in the same
 * place — a folder on a host — so they share the host/location cascade.
 */
export function NewWorkspaceMenu({
  trigger,
  onCreated,
}: {
  trigger: React.ReactNode;
  onCreated?: (result: { workspaceId: string; focusSessionId: string | null }) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [pickerHost, setPickerHost] = useState<Host | null>(null);
  const [pickerChoice, setPickerChoice] = useState<Choice>({ kind: "blank" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const hostsQ = useQuery({ queryKey: ["hosts"], queryFn: hosts.list, staleTime: 15_000 });
  const templatesQ = useQuery({
    queryKey: ["workspace-templates"],
    queryFn: workspaceTemplates.list,
    staleTime: 30_000,
  });
  const hostList = hostsQ.data ?? [];

  const createM = useMutation({
    mutationFn: async ({ choice, host, cwd }: { choice: Choice; host: Host; cwd: string }) => {
      if (choice.kind === "template") {
        return instantiateTemplate(choice.template, host, cwd);
      }
      // A blank workspace opens empty: one tab on its empty state, homed at
      // the folder just chosen. Booting a terminal nobody asked for makes the
      // first thing you do closing it.
      const result = await workspaces.create({ host_id: host.id, cwd });
      return { workspaceId: result.workspace.id, focusSessionId: null };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", result.workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onCreated?.(result);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const createAt = (host: Host, cwd: string, choice: Choice) => {
    if (host.status !== "online" || createM.isPending) return;
    createM.mutate({ choice, host, cwd });
  };

  // Straight to the folder modal: with one host, choosing an item opens the
  // picker; with several, one hop picks the host and then the picker opens.
  const pickFolder = (host: Host, choice: Choice) => {
    setPickerChoice(choice);
    setPickerHost(host);
    setPickerOpen(true);
  };

  const target = (choice: Choice) =>
    hostList.length === 1 && hostList[0]
      ? {
          disabled: hostList[0].status !== "online",
          onSelect: () => pickFolder(hostList[0] as Host, choice),
        }
      : {
          panel: {
            id: `hosts-${choiceKey(choice)}`,
            title: "Choose a host",
            loading: hostsQ.isLoading,
            emptyLabel: "Connect a host before creating a workspace.",
            items: hostList.map((host) => ({
              key: host.id,
              icon: <StatusDot tone={hostStatusTone(host.status)} label={host.status} />,
              label: host.name,
              disabled: host.status === "offline",
              onSelect: () => pickFolder(host, choice),
            })),
          } satisfies CascadePanel,
        };

  const templates = templatesQ.data ?? [];
  // No panel header and no per-template icons: folder first, then the saved
  // templates straight underneath.
  const root: CascadePanel = {
    id: "new-workspace",
    items: [
      {
        key: "blank",
        icon: <FolderOpen />,
        label: "Select folder",
        ...target({ kind: "blank" }),
      },
      ...(templates.length > 0
        ? [{ key: "templates-heading", label: "Templates", heading: true }]
        : []),
      ...templates.map((template) => {
        const homeHost = template.host_id
          ? hostList.find((host) => host.id === template.host_id)
          : undefined;
        const home = homeHost && template.cwd ? { host: homeHost, cwd: template.cwd } : null;
        return {
          key: template.id,
          label: template.name,
          // A remembered folder skips the cascade entirely; the picker is
          // only the fallback when the template's host is gone.
          ...(home
            ? {
                disabled: home.host.status !== "online",
                detail: home.host.status !== "online" ? `${home.host.name} is offline` : undefined,
                onSelect: () => createAt(home.host, home.cwd, { kind: "template", template }),
              }
            : target({ kind: "template", template })),
        };
      }),
    ],
  };

  return (
    <>
      <CascadeMenu
        root={root}
        className="block w-full"
        // Narrower than the cascade default: the items are short labels, and
        // in the sidebar the menu should sit inside the button it drops from
        // rather than out-measuring it.
        menuClassName="w-52"
        sheetTitle="New workspace"
        renderTrigger={(triggerProps) =>
          isValidElement(trigger) ? (
            <Slot
              {...triggerProps}
              aria-disabled={createM.isPending || undefined}
              onClick={createM.isPending ? undefined : triggerProps.onClick}
            >
              {trigger}
            </Slot>
          ) : (
            <button {...triggerProps} type="button">
              {trigger as React.ReactNode}
            </button>
          )
        }
      />
      <FolderPickerDialog
        key={`${pickerHost?.id ?? "none"}:${pickerOpen ? "open" : "closed"}`}
        open={pickerOpen}
        host={pickerHost}
        onOpenChange={setPickerOpen}
        onSelect={(path) => {
          if (pickerHost) createAt(pickerHost, path, pickerChoice);
        }}
      />
    </>
  );
}
