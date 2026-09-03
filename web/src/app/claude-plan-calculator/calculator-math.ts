/*
 * Pure math for the Claude plan calculator — no React, no I/O. The island
 * (Calculator.tsx) calls `calculate` on every input change and renders the
 * result; the sources behind every constant are listed at the top of that
 * file. Two kinds of number live here and the UI keeps them apart:
 *
 *   published — prices per plan and per million tokens, the 5x/20x
 *               multipliers, which model each plan starts Claude Code on;
 *   assumed   — tokens per active hour for each intensity, and the
 *               API-equivalent value of Pro's included usage (the anchor
 *               every plan band scales from). Both are editable in the UI.
 */

export type ModelId = "sonnet" | "opus";

/** API list prices in dollars per million tokens. */
export interface ModelPrice {
  id: ModelId;
  name: string;
  input: number;
  cacheRead: number;
  output: number;
}

export const MODEL_PRICES: Record<ModelId, ModelPrice> = {
  sonnet: { id: "sonnet", name: "Sonnet 5", input: 2, cacheRead: 0.2, output: 10 },
  opus: { id: "opus", name: "Opus 5", input: 5, cacheRead: 0.5, output: 25 },
};

export type PlanId = "pro" | "max5" | "max20";

export interface Plan {
  id: PlanId;
  name: string;
  /** Dollars per month on monthly billing. */
  price: number;
  /** Anthropic's published usage multiplier relative to Pro, per session. */
  multiplier: number;
  /** The model Claude Code starts on for this plan. */
  defaultModel: ModelId;
}

export const PLANS: readonly Plan[] = [
  { id: "pro", name: "Pro", price: 20, multiplier: 1, defaultModel: "sonnet" },
  { id: "max5", name: "Max 5x", price: 100, multiplier: 5, defaultModel: "opus" },
  { id: "max20", name: "Max 20x", price: 200, multiplier: 20, defaultModel: "opus" },
];

/** Tokens moved per active hour of agent work, by kind. */
export interface TokenProfile {
  /** Input the model has not seen before — new files, tool output, prompts. */
  freshInput: number;
  /** The re-sent conversation, served from the prompt cache. */
  cacheRead: number;
  /** What the model writes: thinking, edits, replies. */
  output: number;
}

export type IntensityId = "light" | "typical" | "heavy";

/**
 * Assumed, not published. Claude Code re-sends the whole conversation on
 * every request and an agentic turn makes many requests, so cache reads
 * dominate; the presets scale the three kinds together.
 */
export const INTENSITY_PRESETS: Record<IntensityId, TokenProfile> = {
  light: { freshInput: 200_000, cacheRead: 2_000_000, output: 20_000 },
  typical: { freshInput: 600_000, cacheRead: 8_000_000, output: 50_000 },
  heavy: { freshInput: 1_500_000, cacheRead: 20_000_000, output: 120_000 },
};

/** A low and high estimate in the same unit. */
export interface Band {
  lo: number;
  hi: number;
}

/**
 * Assumed, not published: what Pro's included usage is worth per month at
 * API list prices. Every plan band is this times the plan's multiplier.
 */
export const PRO_BAND_DEFAULT: Band = { lo: 40, hi: 150 };

export const WEEKS_PER_MONTH = 52 / 12;

export interface CalculatorInput {
  /** Hours per day in which an agent is actively working, 0–24. */
  hoursPerDay: number;
  /** Days per week, 0–7. */
  daysPerWeek: number;
  /** Share of active hours on Opus, 0–1; the rest is Sonnet. */
  opusShare: number;
  profile: TokenProfile;
  proBand?: Band;
  /** Informational only: the pool is per account, not per machine. */
  machines?: number;
}

export type Fit = "comfortable" | "likely" | "unlikely";

export interface PlanVerdict {
  plan: Plan;
  /** API-equivalent dollars per month the plan plausibly covers. */
  band: Band;
  fit: Fit;
  /** Dollars per month beyond the band: lo against band.hi, hi against band.lo. */
  overflow: Band;
}

/**
 * Why the recommended plan won: it covers the estimate outright; it probably
 * covers it and credits for the overflow cost less than the next plan up; or
 * the cheaper plan's worst-case overflow costs more than the step up, so the
 * step up is the buy.
 */
export type RecommendationReason = "comfortable" | "credits" | "upgrade";

export interface Recommendation {
  planId: PlanId | null;
  fit: Fit | null;
  reason: RecommendationReason | null;
  /** The cheaper plan an "upgrade" recommendation stepped past. */
  insteadOf: PlanId | null;
  /** True when the pay-as-you-go API at list would cost less than the plan. */
  apiCheaper: boolean;
}

export interface CalculatorResult {
  activeHoursPerMonth: number;
  tokens: { freshInput: number; cacheRead: number; output: number; total: number };
  /** Dollars per active hour at API list prices. */
  hourly: { sonnet: number; opus: number; blended: number };
  /** Dollars per month at API list prices. */
  apiCost: number;
  plans: PlanVerdict[];
  recommendation: Recommendation;
}

export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** Tokens can't be negative; anything unparseable counts as zero. */
export function sanitizeProfile(profile: TokenProfile): TokenProfile {
  return {
    freshInput: clamp(profile.freshInput, 0, Number.MAX_SAFE_INTEGER),
    cacheRead: clamp(profile.cacheRead, 0, Number.MAX_SAFE_INTEGER),
    output: clamp(profile.output, 0, Number.MAX_SAFE_INTEGER),
  };
}

/** A band with lo ≤ hi and nothing negative. */
export function sanitizeBand(band: Band): Band {
  const lo = clamp(band.lo, 0, Number.MAX_SAFE_INTEGER);
  const hi = clamp(band.hi, 0, Number.MAX_SAFE_INTEGER);
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo };
}

/** Dollars per active hour for one model at list prices. */
export function hourlyCost(profile: TokenProfile, model: ModelPrice): number {
  const p = sanitizeProfile(profile);
  return (
    (p.freshInput * model.input + p.cacheRead * model.cacheRead + p.output * model.output) /
    1_000_000
  );
}

export function planBand(plan: Plan, proBand: Band = PRO_BAND_DEFAULT): Band {
  const base = sanitizeBand(proBand);
  return { lo: base.lo * plan.multiplier, hi: base.hi * plan.multiplier };
}

export function classifyFit(monthly: number, band: Band): Fit {
  if (monthly <= band.lo) return "comfortable";
  if (monthly <= band.hi) return "likely";
  return "unlikely";
}

export function calculate(input: CalculatorInput): CalculatorResult {
  const hoursPerDay = clamp(input.hoursPerDay, 0, 24);
  const daysPerWeek = clamp(input.daysPerWeek, 0, 7);
  const opusShare = clamp(input.opusShare, 0, 1);
  const profile = sanitizeProfile(input.profile);
  const proBand = sanitizeBand(input.proBand ?? PRO_BAND_DEFAULT);

  const activeHoursPerMonth = hoursPerDay * daysPerWeek * WEEKS_PER_MONTH;

  const tokens = {
    freshInput: profile.freshInput * activeHoursPerMonth,
    cacheRead: profile.cacheRead * activeHoursPerMonth,
    output: profile.output * activeHoursPerMonth,
    total: 0,
  };
  tokens.total = tokens.freshInput + tokens.cacheRead + tokens.output;

  const sonnet = hourlyCost(profile, MODEL_PRICES.sonnet);
  const opus = hourlyCost(profile, MODEL_PRICES.opus);
  const blended = (1 - opusShare) * sonnet + opusShare * opus;
  const apiCost = blended * activeHoursPerMonth;

  const plans: PlanVerdict[] = PLANS.map((plan) => {
    const band = planBand(plan, proBand);
    return {
      plan,
      band,
      fit: classifyFit(apiCost, band),
      overflow: {
        lo: Math.max(0, apiCost - band.hi),
        hi: Math.max(0, apiCost - band.lo),
      },
    };
  });

  const recommendation = recommend(plans, apiCost);

  return {
    activeHoursPerMonth,
    tokens,
    hourly: { sonnet, opus, blended },
    apiCost,
    plans,
    recommendation,
  };
}

/**
 * The cheapest plan that isn't ruled out wins — unless it only probably
 * covers the estimate and its worst-case overflow, paid as credits at API
 * rates, would cost more than stepping up to the next plan.
 */
export function recommend(plans: readonly PlanVerdict[], apiCost: number): Recommendation {
  const index = plans.findIndex((v) => v.fit !== "unlikely");
  if (index < 0) {
    return { planId: null, fit: null, reason: null, insteadOf: null, apiCheaper: false };
  }
  const cheapest = plans[index];
  if (cheapest.fit === "comfortable") {
    return {
      planId: cheapest.plan.id,
      fit: cheapest.fit,
      reason: "comfortable",
      insteadOf: null,
      apiCheaper: apiCost < cheapest.plan.price,
    };
  }
  const next = plans[index + 1];
  if (next && cheapest.overflow.hi > next.plan.price - cheapest.plan.price) {
    return {
      planId: next.plan.id,
      fit: next.fit,
      reason: "upgrade",
      insteadOf: cheapest.plan.id,
      apiCheaper: apiCost < next.plan.price,
    };
  }
  return {
    planId: cheapest.plan.id,
    fit: cheapest.fit,
    reason: "credits",
    insteadOf: null,
    apiCheaper: apiCost < cheapest.plan.price,
  };
}

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole dollars from $10 up, cents below — a calculator, not an invoice. */
export function formatUsd(value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  return v >= 10 || v === 0 ? usd0.format(v) : usd2.format(v);
}

/** "0", "850K", "12.3M", "1.2B" — one significant decimal past a thousand. */
export function formatTokens(value: number): string {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (v < 1_000) return String(Math.round(v));
  const units: [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [size, suffix] of units) {
    if (v >= size) {
      const n = v / size;
      const text = n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "");
      return `${text}${suffix}`;
    }
  }
  return String(Math.round(v));
}
