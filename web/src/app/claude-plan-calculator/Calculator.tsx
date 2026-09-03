"use client";

import { useId, useState } from "react";
import {
  type Band,
  calculate,
  type Fit,
  formatTokens,
  formatUsd,
  INTENSITY_PRESETS,
  type IntensityId,
  MODEL_PRICES,
  PLANS,
  PRO_BAND_DEFAULT,
  type TokenProfile,
} from "./calculator-math";

/*
 * Facts checked 2026-09-03 against:
 *
 *   https://claude.com/pricing
 *     Pro $20/month ($17/month billed annually); Max "5x or 20x more usage
 *     than Pro"; Claude Code included on Pro and Max.
 *   https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 *     Max 5x $100/month, Max 20x $200/month; "Max 5x provides five times
 *     more usage per session than the Pro plan", "Max 20x provides 20 times".
 *   https://support.claude.com/en/articles/8325606-what-is-the-pro-plan
 *     $20/month; session usage resets every five hours; a weekly limit that
 *     applies across all models, resetting at a fixed time each week.
 *   https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
 *     Limits are shared across Claude and Claude Code; "consider upgrading
 *     to the Max 5x plan if you consistently hit limits".
 *   https://support.claude.com/en/articles/12429409-manage-extra-usage-for-paid-claude-plans
 *     Usage credits for Pro, Max 5x, Max 20x; billed at standard API rates;
 *     a monthly spend limit you set; $2,000 daily redemption limit.
 *   https://support.claude.com/en/articles/14246112-buy-usage-bundles
 *     Bundles: $50 at 10% off, $250 at 20%, $1,000 at 30%; individuals may
 *     buy up to $2,000 of discounted bundles per month.
 *   https://code.claude.com/docs/en/model-config
 *     Claude Code default model: Sonnet 5 on Pro (and Team Standard), Opus 5
 *     on Max (Team Premium, Enterprise, API); /model switches.
 *   https://code.claude.com/docs/en/costs
 *     /usage shows plan usage bars for subscribers and per-session token
 *     stats; /usage-credits manages credits; the prompt cache lives one hour
 *     on a subscription, five minutes while drawing on usage credits;
 *     enterprise averages of ~$13 per developer per active day and $150–250
 *     per developer per month on API billing.
 *   https://code.claude.com/docs/en/commands
 *     /cost is an alias for /usage.
 *   https://code.claude.com/docs/en/errors
 *     "You've hit your session limit" (five-hour rolling window), "weekly
 *     limit", and per-model "Opus limit" / "Sonnet limit" messages.
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *     API list: Sonnet 5 $2 in / $0.20 cache read / $10 out per MTok;
 *     Opus 5 $5 / $0.50 / $25.
 *
 * Not published by Anthropic, therefore assumed and editable below: tokens
 * per active hour for each intensity, and the API-equivalent dollar value of
 * Pro's included usage per month (the anchor the 5x and 20x bands scale from).
 */

const FIT_LABEL: Record<Fit, string> = {
  comfortable: "Covers it",
  likely: "Probably covers it",
  unlikely: "Won’t cover it",
};

const FIT_CLASS: Record<Fit, string> = {
  comfortable: "text-bone ring-line-strong",
  likely: "text-ash ring-line-g",
  unlikely: "text-ember ring-ember/40",
};

const INTENSITY_LABEL: Record<IntensityId, { name: string; hint: string }> = {
  light: { name: "Light", hint: "small repo, short turns, mostly you typing" },
  typical: { name: "Typical", hint: "an agent working through tasks with tool calls" },
  heavy: { name: "Heavy", hint: "long autonomous runs, big contexts, few clears" },
};

const RANGE_CLASS = "mt-2 block w-full cursor-pointer accent-hellfire";
const NUMBER_CLASS =
  "mt-1 w-full rounded-md bg-void px-3 py-2 font-sigil text-[13px] leading-6 text-bone ring-1 ring-line-g outline-none focus:ring-line-strong";
const LABEL_CLASS = "flex items-baseline justify-between text-[13px] leading-6 text-ash";
const VALUE_CLASS = "font-sigil text-[13px] text-bone";

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function bandText(band: Band): string {
  return `${formatUsd(band.lo)}–${formatUsd(band.hi)}`;
}

export function Calculator() {
  const id = useId();
  const [hoursPerDay, setHoursPerDay] = useState(4);
  const [daysPerWeek, setDaysPerWeek] = useState(5);
  const [opusPct, setOpusPct] = useState(50);
  const [intensity, setIntensity] = useState<IntensityId | "custom">("typical");
  const [custom, setCustom] = useState<TokenProfile>(INTENSITY_PRESETS.typical);
  const [proBand, setProBand] = useState<Band>(PRO_BAND_DEFAULT);
  const [machines, setMachines] = useState(1);

  const profile = intensity === "custom" ? custom : INTENSITY_PRESETS[intensity];
  const result = calculate({
    hoursPerDay,
    daysPerWeek,
    opusShare: opusPct / 100,
    profile,
    proBand,
    machines,
  });

  const { recommendation } = result;
  const picked = result.plans.find((v) => v.plan.id === recommendation.planId);
  const passed = result.plans.find((v) => v.plan.id === recommendation.insteadOf);
  const pickedIndex = picked ? result.plans.indexOf(picked) : -1;
  const next = pickedIndex >= 0 ? result.plans[pickedIndex + 1] : undefined;
  const top = result.plans[result.plans.length - 1];

  function editProfile(key: keyof TokenProfile, value: string) {
    const n = Number(value);
    setCustom({ ...profile, [key]: Number.isFinite(n) ? n : 0 });
    setIntensity("custom");
  }

  function editBand(key: keyof Band, value: string) {
    const n = Number(value);
    setProBand({ ...proBand, [key]: Number.isFinite(n) ? n : 0 });
  }

  function reset() {
    setIntensity("typical");
    setCustom(INTENSITY_PRESETS.typical);
    setProBand(PRO_BAND_DEFAULT);
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Inputs */}
      <div className="rounded-2xl bg-char px-5 py-6 sm:px-8 sm:py-8">
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-hours`} className={LABEL_CLASS}>
              <span>Active agent hours per day</span>
              <span className={VALUE_CLASS}>{hoursPerDay} h</span>
            </label>
            <input
              id={`${id}-hours`}
              type="range"
              min={0}
              max={12}
              step={0.5}
              value={hoursPerDay}
              onChange={(e) => setHoursPerDay(Number(e.target.value))}
              className={RANGE_CLASS}
            />
            <p className="mt-2 text-[13px] leading-6 text-ash">
              Hours an agent is actually working — not hours the terminal is open.
            </p>
          </div>

          <div>
            <label htmlFor={`${id}-days`} className={LABEL_CLASS}>
              <span>Days per week</span>
              <span className={VALUE_CLASS}>{daysPerWeek}</span>
            </label>
            <input
              id={`${id}-days`}
              type="range"
              min={1}
              max={7}
              step={1}
              value={daysPerWeek}
              onChange={(e) => setDaysPerWeek(Number(e.target.value))}
              className={RANGE_CLASS}
            />
          </div>

          <div>
            <label htmlFor={`${id}-opus`} className={LABEL_CLASS}>
              <span>Model mix</span>
              <span className={VALUE_CLASS}>
                {pct(1 - opusPct / 100)} Sonnet · {pct(opusPct / 100)} Opus
              </span>
            </label>
            <input
              id={`${id}-opus`}
              type="range"
              min={0}
              max={100}
              step={5}
              value={opusPct}
              onChange={(e) => setOpusPct(Number(e.target.value))}
              className={RANGE_CLASS}
            />
            <p className="mt-2 text-[13px] leading-6 text-ash">
              Pro starts Claude Code on Sonnet 5, Max on Opus 5. Opus is 2.5× the price per token.
            </p>
          </div>

          <div>
            <label htmlFor={`${id}-machines`} className={LABEL_CLASS}>
              <span>Machines running agents</span>
              <span className={VALUE_CLASS}>{machines}</span>
            </label>
            <input
              id={`${id}-machines`}
              type="range"
              min={1}
              max={10}
              step={1}
              value={machines}
              onChange={(e) => setMachines(Number(e.target.value))}
              className={RANGE_CLASS}
            />
            <p className="mt-2 text-[13px] leading-6 text-ash">
              Informational: the pool is per account, so every machine you log in on draws from the
              same limits. Count the hours across all of them above.
            </p>
          </div>

          <fieldset className="sm:col-span-2">
            <legend className="text-[13px] leading-6 text-ash">Intensity per active hour</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.keys(INTENSITY_PRESETS) as IntensityId[]).map((key) => {
                const selected = intensity === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setIntensity(key)}
                    className={
                      selected
                        ? "rounded-full bg-bone px-3.5 py-1 text-[13px] leading-6 font-medium text-void"
                        : "rounded-full px-3.5 py-1 text-[13px] leading-6 text-ash ring-1 ring-line-g transition-colors hover:text-bone"
                    }
                  >
                    {INTENSITY_LABEL[key].name}
                  </button>
                );
              })}
              {intensity === "custom" ? (
                <span className="rounded-full bg-bone px-3.5 py-1 text-[13px] leading-6 font-medium text-void">
                  Custom
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-[13px] leading-6 text-ash">
              {intensity === "custom"
                ? "Your own tokens per hour, from the assumptions below."
                : `${INTENSITY_LABEL[intensity].hint} — ${formatTokens(
                    profile.freshInput,
                  )} fresh input, ${formatTokens(profile.cacheRead)} cache reads, ${formatTokens(
                    profile.output,
                  )} output per hour.`}
            </p>
          </fieldset>
        </div>
      </div>

      {/* Outputs */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl px-5 py-4 ring-1 ring-line-g">
          <p className="text-[13px] leading-6 text-ash">Active hours a month</p>
          <p className="mt-1 font-sigil text-[22px] leading-8 text-bone">
            {Math.round(result.activeHoursPerMonth)}
          </p>
        </div>
        <div className="rounded-xl px-5 py-4 ring-1 ring-line-g">
          <p className="text-[13px] leading-6 text-ash">Tokens a month</p>
          <p className="mt-1 font-sigil text-[22px] leading-8 text-bone">
            {formatTokens(result.tokens.total)}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-ash">
            {formatTokens(result.tokens.cacheRead)} cached ·{" "}
            {formatTokens(result.tokens.freshInput)} fresh · {formatTokens(result.tokens.output)}{" "}
            out
          </p>
        </div>
        <div className="rounded-xl px-5 py-4 ring-1 ring-line-g">
          <p className="text-[13px] leading-6 text-ash">API cost at list, a month</p>
          <p className="mt-1 font-sigil text-[22px] leading-8 text-bone">
            {formatUsd(result.apiCost)}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-ash">
            {formatUsd(result.hourly.blended)} per active hour at this mix
          </p>
        </div>
      </div>

      <ul className="mt-8 space-y-3">
        {result.plans.map((verdict) => (
          <li
            key={verdict.plan.id}
            className="grid gap-3 rounded-xl px-5 py-4 ring-1 ring-line-g sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-6"
          >
            <div>
              <p className="text-[16px] leading-7 font-semibold text-bone">{verdict.plan.name}</p>
              <p className="text-[13px] leading-6 text-ash">
                {formatUsd(verdict.plan.price)} a month
              </p>
            </div>
            <div className="min-w-0 text-[14px] leading-6 text-ash">
              <p>
                Plausibly covers {bandText(verdict.band)} of API-equivalent use a month
                {verdict.plan.multiplier > 1 ? ` (Pro’s band × ${verdict.plan.multiplier})` : ""}.
              </p>
              {verdict.overflow.hi > 0 ? (
                <p className="mt-1">
                  Past the band: {formatUsd(verdict.overflow.lo)}–{formatUsd(verdict.overflow.hi)} a
                  month more as usage credits at API rates.
                </p>
              ) : null}
            </div>
            <span
              className={`inline-flex w-fit items-center rounded-full px-3 py-0.5 font-sigil text-[12px] leading-6 ring-1 ${FIT_CLASS[verdict.fit]}`}
            >
              {FIT_LABEL[verdict.fit]}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-8 rounded-2xl bg-char px-5 py-6 text-[15px] leading-7 sm:px-8">
        <p className="text-bone">
          {picked && recommendation.reason === "comfortable" ? (
            <>
              {picked.plan.name} at {formatUsd(picked.plan.price)} a month should cover this
              comfortably
              {recommendation.apiCheaper
                ? ` — though the API at list would cost about ${formatUsd(
                    result.apiCost,
                  )}, less than the plan, so pay as you go unless you also want Claude in the apps.`
                : "."}
            </>
          ) : picked && recommendation.reason === "upgrade" && passed ? (
            <>
              {passed.plan.name} at {formatUsd(passed.plan.price)} would probably cover this, but
              the overflow it risks — up to {formatUsd(passed.overflow.hi)} a month in usage credits
              — costs more than the {formatUsd(picked.plan.price - passed.plan.price)} step up to{" "}
              {picked.plan.name}, which buys {picked.plan.multiplier / passed.plan.multiplier}× the
              pool. {picked.plan.name} at {formatUsd(picked.plan.price)} is the better buy
              {picked.fit === "comfortable"
                ? ", and it covers this comfortably."
                : `, and it probably covers this; past its band the rest is credits at about ${formatUsd(
                    picked.overflow.lo,
                  )}–${formatUsd(picked.overflow.hi)} a month.`}
            </>
          ) : picked ? (
            <>
              {picked.plan.name} at {formatUsd(picked.plan.price)} a month probably covers this, but
              you are inside its band: a heavy week can reach the cap, and the rest is usage credits
              at about {formatUsd(picked.overflow.lo)}–{formatUsd(picked.overflow.hi)} a month
              {next
                ? ` — less than the ${formatUsd(
                    next.plan.price - picked.plan.price,
                  )} step up to ${next.plan.name}, so credits are the cheaper patch.`
                : " — and there is no bigger plan, so credits are the ceiling."}
            </>
          ) : (
            <>
              No plan covers this. Even {top.plan.name}’s band tops out at {formatUsd(top.band.hi)}.
              Expect to reach the weekly limit and pay the remainder as usage credits, roughly{" "}
              {formatUsd(top.overflow.lo)}–{formatUsd(top.overflow.hi)} a month on top of{" "}
              {formatUsd(top.plan.price)}, or use the API outright at about{" "}
              {formatUsd(result.apiCost)}.
            </>
          )}
        </p>
        <p className="mt-3 text-ash">
          The bands are our anchor for Pro scaled by Anthropic’s published multipliers, not
          published quotas. Limits are enforced per five-hour session and per week, so bursts hit
          them before a monthly average says they should.
        </p>
      </div>

      <details className="group mt-8 rounded-2xl ring-1 ring-line-g open:bg-char">
        <summary className="cursor-pointer list-none px-5 py-4 text-[15px] leading-7 text-bone marker:content-none sm:px-8">
          <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
          Assumptions — edit them
        </summary>
        <div className="px-5 pb-6 sm:px-8">
          <p className="text-[14px] leading-6 text-ash">
            Tokens per active hour, by kind. Claude Code re-sends the conversation on every request
            and an agentic turn makes many requests, so cache reads dominate. Edit any field and the
            intensity becomes “Custom”.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block text-[13px] leading-6 text-ash">
              Fresh input tokens / hour
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={50_000}
                value={profile.freshInput}
                onChange={(e) => editProfile("freshInput", e.target.value)}
                className={NUMBER_CLASS}
              />
            </label>
            <label className="block text-[13px] leading-6 text-ash">
              Cache-read tokens / hour
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={500_000}
                value={profile.cacheRead}
                onChange={(e) => editProfile("cacheRead", e.target.value)}
                className={NUMBER_CLASS}
              />
            </label>
            <label className="block text-[13px] leading-6 text-ash">
              Output tokens / hour
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={5_000}
                value={profile.output}
                onChange={(e) => editProfile("output", e.target.value)}
                className={NUMBER_CLASS}
              />
            </label>
          </div>

          <p className="mt-6 text-[14px] leading-6 text-ash">
            What Pro’s included usage is worth per month at API list prices. Anthropic publishes the
            prices and the 5× and 20× multipliers, not token quotas; this anchor is our estimate,
            and the Max bands are it times the multiplier.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block text-[13px] leading-6 text-ash">
              Pro band, low ($ / month)
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={10}
                value={proBand.lo}
                onChange={(e) => editBand("lo", e.target.value)}
                className={NUMBER_CLASS}
              />
            </label>
            <label className="block text-[13px] leading-6 text-ash">
              Pro band, high ($ / month)
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={10}
                value={proBand.hi}
                onChange={(e) => editBand("hi", e.target.value)}
                className={NUMBER_CLASS}
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                onClick={reset}
                className="rounded-full px-3.5 py-1 text-[13px] leading-6 text-ash ring-1 ring-line-g transition-colors hover:text-bone"
              >
                Reset to defaults
              </button>
            </div>
          </div>

          <dl className="mt-6 grid gap-x-8 gap-y-2 text-[13px] leading-6 text-ash sm:grid-cols-2">
            <div>
              <dt className="text-bone">Published, used as is</dt>
              <dd>
                Pro {formatUsd(PLANS[0].price)}, Max 5x {formatUsd(PLANS[1].price)}, Max 20x{" "}
                {formatUsd(PLANS[2].price)} a month. Max 5x is 5× Pro’s usage per session, Max 20x
                is 20×. {MODEL_PRICES.sonnet.name}: ${MODEL_PRICES.sonnet.input} in, $
                {MODEL_PRICES.sonnet.cacheRead} cache read, ${MODEL_PRICES.sonnet.output} out per
                million tokens. {MODEL_PRICES.opus.name}: ${MODEL_PRICES.opus.input}, $
                {MODEL_PRICES.opus.cacheRead}, ${MODEL_PRICES.opus.output}. A month is 52⁄12 weeks.
              </dd>
            </div>
            <div>
              <dt className="text-bone">Assumed, editable above</dt>
              <dd>
                Tokens per active hour for light, typical, and heavy work; that plan usage scales
                with the API-list value of what you send, so an Opus hour draws 2.5× a Sonnet hour;
                and the Pro anchor of {formatUsd(PRO_BAND_DEFAULT.lo)}–
                {formatUsd(PRO_BAND_DEFAULT.hi)}.
              </dd>
            </div>
          </dl>
        </div>
      </details>
    </div>
  );
}
