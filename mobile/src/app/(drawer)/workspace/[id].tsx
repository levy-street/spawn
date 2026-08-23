import { type Href, useLocalSearchParams, useRouter } from "expo-router";

import { WorkspaceDetail } from "@/components/workspace-detail/workspace-detail";

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default function WorkspaceDetailRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const router = useRouter();
  const workspaceId = firstParam(params.id);

  return (
    <WorkspaceDetail
      onBack={() => router.back()}
      onOpenFiles={(hostId, path) => {
        router.push(`/host/${hostId}/files?path=${encodeURIComponent(path)}` as Href);
      }}
      onOpenTerminal={(sessionId) => {
        router.push(`/terminal/${sessionId}` as Href);
      }}
      workspaceId={workspaceId}
    />
  );
}
