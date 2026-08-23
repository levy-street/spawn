import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { FooterActions } from "@/components/ui/footer-actions";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { sizing } from "@/theme/sizing";

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
  // A confirmation is a question with two answers, not a page. It comes up from
  // the bottom where the thumb already is; full-page presentation is reserved for
  // forms, which need the room and the keyboard.
  return (
    <Sheet onDismiss={onCancel} testID="confirm-sheet" visible={visible}>
      <View style={styles.body}>
        <Text accessibilityRole="header" variant="uiLg" weight="semibold">
          {title}
        </Text>
        {description !== undefined ? (
          typeof description === "string" || typeof description === "number" ? (
            <Text color="mutedForeground" variant="body">
              {description}
            </Text>
          ) : (
            description
          )
        ) : null}
      </View>
      <FooterActions>
        <Button onPress={onCancel} variant="outline">
          {cancelLabel}
        </Button>
        <Button onPress={onConfirm} variant={destructive ? "destructive" : "default"}>
          {confirmLabel}
        </Button>
      </FooterActions>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: sizing.space.peer,
    paddingBottom: sizing.space.block,
    paddingHorizontal: sizing.space.block,
    paddingTop: sizing.space.tight,
  },
});

/** Mount once near the app root for the promise-returning `confirm()` helper. */
export function ConfirmHost(): React.JSX.Element | null {
  const request = useSyncExternalStore(subscribe, snapshot, () => null);
  if (!request) return null;
  const { resolve: _resolve, ...options } = request;

  return (
    <Confirm {...options} onCancel={() => settle(false)} onConfirm={() => settle(true)} visible />
  );
}
