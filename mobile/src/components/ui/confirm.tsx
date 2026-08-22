import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface ConfirmProps extends ConfirmOptions {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

let pendingConfirm: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function settle(confirmed: boolean): void {
  const pending = pendingConfirm;
  pendingConfirm = null;
  emit();
  pending?.resolve(confirmed);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): PendingConfirm | null {
  return pendingConfirm;
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  pendingConfirm?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pendingConfirm = { ...options, resolve };
    emit();
  });
}

export function useConfirm(): typeof confirm {
  return confirm;
}

export function Confirm({
  visible,
  onConfirm,
  onCancel,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
}: ConfirmProps): React.JSX.Element {
  const footer = (
    <>
      <Button onPress={onCancel} size="sm" variant="outline">
        {cancelLabel}
      </Button>
      <Button onPress={onConfirm} size="sm" variant={destructive ? "destructive" : "default"}>
        {confirmLabel}
      </Button>
    </>
  );

  return (
    <Dialog
      description={description}
      footer={footer}
      onDismiss={onCancel}
      showCloseButton={false}
      size="sm"
      title={title}
      visible={visible}
    />
  );
}

/** Mount once near the app root for the promise-returning `confirm()` helper. */
export function ConfirmHost(): React.JSX.Element | null {
  const request = useSyncExternalStore(subscribe, snapshot, () => null);
  if (!request) return null;
  const { resolve: _resolve, ...options } = request;

  return (
    <Confirm {...options} onCancel={() => settle(false)} onConfirm={() => settle(true)} visible />
  );
}
