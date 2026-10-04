import { useState } from "react";
import { FileBrowserBody, type FolderNavigation } from "@/components/files/file-browser-body";
import { displayPath, normalizeCwdForHost, pathFlavorForHostOS } from "@/components/files/paths";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { useHostHome } from "@/data/queries/files";

export interface FileExplorerProps {
  hostId: string;
  hostName: string;
  hostIdentityPublicKey: string;
  hostOS?: string | null;
  initialPath?: string;
  /** Leaves the explorer. */
  onBack(): void;
  /**
   * Shows another folder as a screen of its own (the host files route). Without
   * it the explorer changes folder in place, and back leaves it.
   */
  onOpenFolder?(navigation: FolderNavigation): void;
}

/**
 * A host's files as a screen: one header, naming the host and the folder, over
 * the browser body, whose own toolbar holds the folder's controls.
 */
export function FileExplorer({
  hostId,
  hostName,
  hostIdentityPublicKey,
  hostOS,
  initialPath,
  onBack,
  onOpenFolder,
}: FileExplorerProps) {
  const [inPlacePath, setInPlacePath] = useState(initialPath);
  const path = onOpenFolder ? initialPath : inPlacePath;
  // The body says which folder it shows: a link to a file shows the file's folder.
  const [shown, setShown] = useState<string | null>(null);
  const pathFlavor = pathFlavorForHostOS(hostOS);
  // Read from the cache the body fills; this header never asks the host itself.
  const home = useHostHome(hostId, null, false);
  const homeDir = home.data?.home_dir;
  const where = homeDir
    ? displayPath(shown ?? normalizeCwdForHost(path, homeDir, pathFlavor), homeDir, pathFlavor)
    : null;
  return (
    <Screen
      header={
        <AppHeader
          onBack={onBack}
          subtitle={where ? `${hostName} · ${where}` : hostName}
          title="Files"
        />
      }
      padded={false}
    >
      <FileBrowserBody
        hostId={hostId}
        hostIdentityPublicKey={hostIdentityPublicKey}
        hostName={hostName}
        hostOS={hostOS ?? null}
        onOpenFolder={onOpenFolder ?? ((navigation) => setInPlacePath(navigation.path))}
        onShowFolder={setShown}
        {...(path === undefined ? {} : { path })}
      />
    </Screen>
  );
}
