import { describe, expect, it } from "bun:test";
import {
  calculate,
  classifyFit,
  formatTokens,
  formatUsd,
  hourlyCost,
  INTENSITY_PRESETS,
  MODEL_PRICES,
  PLANS,
  PRO_BAND_DEFAULT,
  planBand,
  sanitizeBand,
  sanitizeProfile,
  WEEKS_PER_MONTH,
} from "./calculator-math";

const typical = INTENSITY_PRESETS.typical;

describe("published constants", () => {
  it("prices the plans as Anthropic lists them, cheapest first", () => {
    expect(PLANS.map((p) => [p.id, p.price, p.multiplier])).toEqual([
      ["pro", 20, 1],
      ["max5", 100, 5],
      ["max20", 200, 20],
    ]);
    expect(PLANS[0].defaultModel).toBe("sonnet");
    expect(PLANS[1].defaultModel).toBe("opus");
  });

  it("keeps Opus at 2.5x Sonnet on every token kind, cache reads at a tenth of input", () => {
    const { sonnet, opus } = MODEL_PRICES;
    expect(opus.input / sonnet.input).toBe(2.5);
    expect(opus.output / sonnet.output).toBe(2.5);
    expect(sonnet.cacheRead).toBeCloseTo(sonnet.input / 10);
    expect(opus.cacheRead).toBeCloseTo(opus.input / 10);
  });

  it("orders the intensity presets", () => {
    const { light, heavy } = INTENSITY_PRESETS;
    for (const key of ["freshInput", "cacheRead", "output"] as const) {
      expect(light[key]).toBeLessThan(typical[key]);
      expect(typical[key]).toBeLessThan(heavy[key]);
    }
  });
});

describe("hourlyCost", () => {
  it("prices one hour at list", () => {
    // 0.6M × $2 + 8M × $0.20 + 0.05M × $10 = 1.2 + 1.6 + 0.5
    expect(hourlyCost(typical, MODEL_PRICES.sonnet)).toBeCloseTo(3.3, 6);
    expect(hourlyCost(typical, MODEL_PRICES.opus)).toBeCloseTo(8.25, 6);
  });

  it("treats negative or NaN tokens as zero", () => {
    const junk = { freshInput: -5, cacheRead: Number.NaN, output: 1_000_000 };
    expect(hourlyCost(junk, MODEL_PRICES.sonnet)).toBeCloseTo(10, 6);
    expect(sanitizeProfile(junk)).toEqual({ freshInput: 0, cacheRead: 0, output: 1_000_000 });
  });
});

describe("plan bands", () => {
  it("scales the Pro anchor by the published multiplier", () => {
    expect(planBand(PLANS[0])).toEqual(PRO_BAND_DEFAULT);
    expect(planBand(PLANS[1])).toEqual({
      lo: PRO_BAND_DEFAULT.lo * 5,
      hi: PRO_BAND_DEFAULT.hi * 5,
    });
    expect(planBand(PLANS[2], { lo: 10, hi: 20 })).toEqual({ lo: 200, hi: 400 });
  });

  it("repairs an inverted or negative band", () => {
    expect(sanitizeBand({ lo: 150, hi: 40 })).toEqual({ lo: 40, hi: 150 });
    expect(sanitizeBand({ lo: -1, hi: Number.NaN })).toEqual({ lo: 0, hi: 0 });
  });

  it("classifies the boundaries inclusively", () => {
    const band = { lo: 40, hi: 150 };
    expect(classifyFit(0, band)).toBe("comfortable");
    expect(classifyFit(40, band)).toBe("comfortable");
    expect(classifyFit(40.01, band)).toBe("likely");
    expect(classifyFit(150, band)).toBe("likely");
    expect(classifyFit(150.01, band)).toBe("unlikely");
  });
});

describe("calculate", () => {
  it("returns zeros and recommends Pro for no use at all", () => {
    const r = calculate({ hoursPerDay: 0, daysPerWeek: 5, opusShare: 0.5, profile: typical });
    expect(r.activeHoursPerMonth).toBe(0);
    expect(r.tokens.total).toBe(0);
    expect(r.apiCost).toBe(0);
    expect(r.plans.every((v) => v.fit === "comfortable")).toBe(true);
    expect(r.recommendation).toEqual({
      planId: "pro",
      fit: "comfortable",
      reason: "comfortable",
      insteadOf: null,
      apiCheaper: true,
    });
  });

  it("multiplies hours, days, and weeks per month", () => {
    const r = calculate({ hoursPerDay: 4, daysPerWeek: 5, opusShare: 0, profile: typical });
    expect(r.activeHoursPerMonth).toBeCloseTo(4 * 5 * WEEKS_PER_MONTH, 9);
    expect(r.tokens.cacheRead).toBeCloseTo(typical.cacheRead * r.activeHoursPerMonth, 3);
    expect(r.tokens.total).toBeCloseTo(
      (typical.freshInput + typical.cacheRead + typical.output) * r.activeHoursPerMonth,
      3,
    );
    expect(r.apiCost).toBeCloseTo(3.3 * r.activeHoursPerMonth, 6);
  });

  it("blends the model mix linearly", () => {
    const base = { hoursPerDay: 1, daysPerWeek: 7, profile: typical };
    const sonnetOnly = calculate({ ...base, opusShare: 0 });
    const opusOnly = calculate({ ...base, opusShare: 1 });
    const half = calculate({ ...base, opusShare: 0.5 });
    expect(sonnetOnly.hourly.blended).toBeCloseTo(3.3, 6);
    expect(opusOnly.hourly.blended).toBeCloseTo(8.25, 6);
    expect(half.hourly.blended).toBeCloseTo((3.3 + 8.25) / 2, 6);
  });

  it("clamps out-of-range inputs instead of extrapolating", () => {
    const r = calculate({ hoursPerDay: 99, daysPerWeek: 30, opusShare: 7, profile: typical });
    expect(r.activeHoursPerMonth).toBeCloseTo(24 * 7 * WEEKS_PER_MONTH, 9);
    expect(r.hourly.blended).toBeCloseTo(8.25, 6);
  });

  it("steps up when the cheaper plan's worst-case overflow costs more than the upgrade", () => {
    // 2h × 5d on Sonnet ≈ $143/mo: Pro is only likely (band 40–150) and its
    // worst-case overflow (~$103) beats the $80 step to Max 5x, which covers it.
    const mid = calculate({ hoursPerDay: 2, daysPerWeek: 5, opusShare: 0, profile: typical });
    expect(mid.plans[0].fit).toBe("likely");
    expect(mid.plans[1].fit).toBe("comfortable");
    expect(mid.recommendation).toEqual({
      planId: "max5",
      fit: "comfortable",
      reason: "upgrade",
      insteadOf: "pro",
      apiCheaper: false,
    });
  });

  it("stays on the cheaper plan with credits when the overflow is small", () => {
    // ≈ $43/mo: just past Pro's low anchor; worst case $3 of credits, far under $80.
    const r = calculate({ hoursPerDay: 0.6, daysPerWeek: 5, opusShare: 0, profile: typical });
    expect(r.plans[0].fit).toBe("likely");
    expect(r.plans[0].overflow.hi).toBeLessThan(80);
    expect(r.recommendation).toEqual({
      planId: "pro",
      fit: "likely",
      reason: "credits",
      insteadOf: null,
      apiCheaper: false,
    });
  });

  it("recommends Max 20x with credits when it is the last plan standing", () => {
    // Anchor Max 20x's band around the estimate so it's likely with no plan above it.
    const r = calculate({
      hoursPerDay: 4,
      daysPerWeek: 5,
      opusShare: 1,
      profile: typical,
      proBand: { lo: 20, hi: 40 },
    });
    expect(r.plans.map((v) => v.fit)).toEqual(["unlikely", "unlikely", "likely"]);
    expect(r.recommendation.planId).toBe("max20");
    expect(r.recommendation.reason).toBe("credits");
  });

  it("recommends nothing when even Max 20x is unlikely, with overflow priced at list", () => {
    const r = calculate({
      hoursPerDay: 12,
      daysPerWeek: 7,
      opusShare: 1,
      profile: INTENSITY_PRESETS.heavy,
    });
    expect(r.plans[2].fit).toBe("unlikely");
    expect(r.recommendation).toEqual({
      planId: null,
      fit: null,
      reason: null,
      insteadOf: null,
      apiCheaper: false,
    });
    const max20 = r.plans[2];
    expect(max20.overflow.lo).toBeCloseTo(r.apiCost - max20.band.hi, 6);
    expect(max20.overflow.hi).toBeCloseTo(r.apiCost - max20.band.lo, 6);
    expect(max20.overflow.lo).toBeLessThan(max20.overflow.hi);
  });

  it("flags when pay-as-you-go would undercut the recommended plan", () => {
    const light = calculate({
      hoursPerDay: 0.5,
      daysPerWeek: 2,
      opusShare: 0,
      profile: INTENSITY_PRESETS.light,
    });
    expect(light.apiCost).toBeLessThan(20);
    expect(light.recommendation).toEqual({
      planId: "pro",
      fit: "comfortable",
      reason: "comfortable",
      insteadOf: null,
      apiCheaper: true,
    });
  });

  it("ignores the machine count — the pool is per account", () => {
    const one = calculate({ hoursPerDay: 3, daysPerWeek: 5, opusShare: 0.5, profile: typical });
    const many = calculate({
      hoursPerDay: 3,
      daysPerWeek: 5,
      opusShare: 0.5,
      profile: typical,
      machines: 6,
    });
    expect(many).toEqual(one);
  });
});

describe("formatting", () => {
  it("formats dollars for reading, not accounting", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(3.3)).toBe("$3.30");
    expect(formatUsd(9.999)).toBe("$10.00");
    expect(formatUsd(143.2)).toBe("$143");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(-4)).toBe("$0");
    expect(formatUsd(Number.NaN)).toBe("$0");
  });

  it("formats token counts with a unit", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(850_000)).toBe("850K");
    expect(formatTokens(12_345_678)).toBe("12.3M");
    expect(formatTokens(1_234_567_890)).toBe("1.2B");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});
