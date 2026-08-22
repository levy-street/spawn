import { duration } from "@/theme";

/** Semantic aliases over the authoritative theme timings. */
export const durations = {
  menu: duration.fast,
  press: duration.base,
  control: duration.base,
  shell: duration.medium,
  toastEnter: duration.medium,
  drawer: duration.panel,
  sheet: duration.panel,
  toastExit: duration.base,
  toastRemoval: duration.toastExitRemoval,
  toastInfo: duration.toastInfo,
  toastAlert: duration.toastAlert,
  toastError: duration.toastError,
  skeletonShimmer: duration.skeleton,
} as const;
