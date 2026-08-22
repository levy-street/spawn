import { Easing } from "react-native-reanimated";

export const duration = {
  instant: 0,
  reduced: 0.01,
  launcherItemStagger: 35,
  sidebarLabelDelay: 75,
  fast: 100,
  base: 150,
  toastExitRemoval: 180,
  medium: 200,
  panel: 220,
  connectingDelay: 240,
  hoverIntent: 260,
  connectingUnmount: 260,
  overlay: 300,
  successHold: 420,
  uploadMinVisible: 420,
  jiggle: 450,
  progress: 500,
  tooltipDelay: 500,
  channelDrift: 750,
  spinner: 1000,
  uploadSheen: 1200,
  skeleton: 2000,
  copyFeedback: 2000,
  connectingSlow: 8000,
  brandMarquee: 56_000,
  grimoireSpin: 90_000,
  grimoireSpinReverse: 140_000,
  toastInfo: 5000,
  toastAlert: 7000,
  toastError: 8000,
} as const;

export const easingCurve = {
  linear: [0, 0, 1, 1],
  cssEase: [0.25, 0.1, 0.25, 1],
  in: [0.4, 0, 1, 1],
  out: [0, 0, 0.2, 1],
  inOut: [0.4, 0, 0.2, 1],
  swift: [0.32, 0.72, 0, 1],
  pulse: [0.4, 0, 0.6, 1],
} as const;

export const easing = {
  linear: Easing.linear,
  cssEase: Easing.bezier(...easingCurve.cssEase),
  in: Easing.bezier(...easingCurve.in),
  out: Easing.bezier(...easingCurve.out),
  inOut: Easing.bezier(...easingCurve.inOut),
  swift: Easing.bezier(...easingCurve.swift),
  pulse: Easing.bezier(...easingCurve.pulse),
} as const;

export const transition = {
  default: { duration: duration.base, easing: easing.inOut },
  press: { duration: duration.base, easing: easing.inOut },
  quickEnter: { duration: duration.fast, easing: easing.cssEase },
  shellGeometry: { duration: duration.medium, easing: easing.swift },
  collapse: { duration: duration.medium, easing: easing.swift },
  drawer: { duration: duration.panel, easing: easing.swift },
  sheet: { duration: duration.panel, easing: easing.out },
  dialog: { duration: duration.base, easing: easing.cssEase },
  overlay: { duration: duration.overlay, easing: easing.cssEase },
  toastEnter: { duration: duration.medium, easing: easing.cssEase },
  toastExit: { duration: duration.base, easing: easing.cssEase },
  statusPulse: { duration: duration.spinner, easing: easing.out },
} as const;

export const gesture = {
  drawerAxisLock: 8,
  drawerDismiss: 70,
  sheetDismiss: 90,
} as const;

export const transform = {
  enterScale: 0.95,
  menuSlide: 16,
  toastSlide: 16,
  drawerHiddenXPercent: -100,
  sheetHiddenYPercent: 100,
  switchThumbOffX: 2,
  switchThumbOnX: 18,
  statusPingScale: 2,
  binJiggleDegrees: [-7, 7],
  launcherHiddenScale: 0.75,
  launcherHoverScale: 1.05,
  launcherPressScale: 0.95,
} as const;

export const pattern = {
  channelDashPx: 2,
  channelPeriodPx: 8,
  channelBackgroundDriftPx: 8,
  uploadSheenBackgroundSizePercent: 200,
  uploadSheenFromPercent: 100,
  uploadSheenToPercent: -100,
} as const;

export const repeat = {
  spinner: { duration: duration.spinner, easing: easing.linear, infinite: true },
  skeleton: { duration: duration.skeleton, easing: easing.pulse, infinite: true },
  statusPing: { duration: duration.spinner, easing: easing.out, infinite: true },
  uploadSheen: { duration: duration.uploadSheen, easing: easing.linear, infinite: true },
  channelDrift: { duration: duration.channelDrift, easing: easing.linear, infinite: true },
  binJiggle: { duration: duration.jiggle, easing: easing.inOut, infinite: true },
} as const;

export const motion = {
  duration,
  easingCurve,
  easing,
  transition,
  gesture,
  transform,
  pattern,
  repeat,
} as const;

export type Motion = typeof motion;
