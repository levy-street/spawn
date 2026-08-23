import * as Haptics from "expo-haptics";

const REPEAT_WINDOW_MS = 50;

let enabled = true;
const lastTriggerByFeedback = new Map<string, number>();

function trigger(feedback: string, operation: () => Promise<void>): void {
  if (!enabled) {
    return;
  }

  const now = Date.now();
  const previous = lastTriggerByFeedback.get(feedback);
  if (previous !== undefined && now - previous < REPEAT_WINDOW_MS) {
    return;
  }
  lastTriggerByFeedback.set(feedback, now);

  try {
    void operation().catch(() => undefined);
  } catch {
    // Native availability differs by device; feedback must never block the interaction.
  }
}

export function setEnabled(nextEnabled: boolean): void {
  if (enabled !== nextEnabled) {
    lastTriggerByFeedback.clear();
  }
  enabled = nextEnabled;
}

const impactStyles = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
} as const;

function selection(): void {
  trigger("selection", Haptics.selectionAsync);
}

function impact(weight: keyof typeof impactStyles): void {
  const style = impactStyles[weight];
  trigger(`impact:${weight}`, () => Haptics.impactAsync(style));
}

function notification(type: Haptics.NotificationFeedbackType): void {
  trigger(`notification:${type}`, () => Haptics.notificationAsync(type));
}

function success(): void {
  notification(Haptics.NotificationFeedbackType.Success);
}

function warning(): void {
  notification(Haptics.NotificationFeedbackType.Warning);
}

function error(): void {
  notification(Haptics.NotificationFeedbackType.Error);
}

export const haptics = {
  selection,
  impact,
  success,
  warning,
  error,
  // Presentation is a light acknowledgement; crossing a dismiss threshold is medium.
  overlayOpen: () => impact("light"),
  overlayDismiss: () => impact("medium"),
} as const;
