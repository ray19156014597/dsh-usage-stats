/**
 * dsh-usage-stats — live peak/off-peak billing period for the DeepSeek price
 * table. Pure functions (no cordis imports) so the schedule can be unit-tested
 * outside the harness; the route handler only adds caching and the loopback
 * fence.
 *
 * The indicator answers one question: "if I send a request right now, is it
 * billed at the peak price or the idle price?" Peak windows are Beijing
 * weekdays 09:00–12:00 and 14:00–18:00; weekends and statutory holidays are
 * idle all day (the same rules `lib/cost.js` uses to price usage samples).
 *
 * @module dsh-usage-stats/price-period
 */

import { beijingDayKey, eraOf, isPeak, priceFor } from "./cost.js";

const MINUTE_MS = 60000;
/** Upper bound for the boundary scan: a holiday run never exceeds ~2 weeks. */
const MAX_SCAN_MINUTES = 21 * 24 * 60;

/** Beijing wall-clock weekday of an epoch. */
function beijingWeekday(timeMs) {
	return new Date(timeMs + 8 * 3600000).getUTCDay(); // 0 = Sunday
}

/** Epoch of `hour:minute` Beijing wall-clock today. */
function beijingTodayAt(timeMs, hour, minute = 0) {
	const shifted = new Date(timeMs + 8 * 3600000);
	return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hour, minute) - 8 * 3600000;
}

/** `09:00–12:00` window labels for a regular peak-priced weekday. */
const PEAK_WINDOWS = [
	{ start: "09:00", end: "12:00" },
	{ start: "14:00", end: "18:00" }
];

/**
 * The next minute at which the peak flag flips, or null when the flag stays
 * constant for the whole scan window (a very long holiday run).
 */
function nextBoundary(now, currentPeak) {
	for (let minutes = 1; minutes <= MAX_SCAN_MINUTES; minutes += 1) {
		const at = now + minutes * MINUTE_MS;
		if (isPeak(at) !== currentPeak) return { at, period: currentPeak ? "idle" : "peak" };
	}
	return null;
}

/** One price row as `{ hit, miss, out }` in CNY per million tokens. */
function priceRow(timeMs, model) {
	const row = priceFor(timeMs, model);
	return row === null ? null : { hit: row.hit, miss: row.miss, out: row.out };
}

/**
 * Describe the live billing situation at `nowMs`.
 * @param nowMs - epoch milliseconds (defaults to `Date.now()`).
 * @returns `{ now, day, weekday, era, pricing, peak, period, reason, windows,
 *   prices, next }` — `period` is `peak` / `idle` / `flat` (pre-2026-08-17
 *   price tables had no peak pricing), `next` is the next peak↔idle flip.
 */
export function describePricePeriod(nowMs = Date.now()) {
	const now = Number.isFinite(nowMs) ? nowMs : Date.now();
	const era = eraOf(now);
	const peakPricing = era.peak === true;
	const peak = isPeak(now);
	const weekday = beijingWeekday(now);
	const weekend = weekday === 0 || weekday === 6;
	// On a weekday the only reason `isPeak` can be false during the 09:00–18:00
	// band is a statutory holiday (the holiday set lives in cost.js), so probing
	// today's 10:00 distinguishes a holiday from a normal off-window evening.
	const holiday = peakPricing && !weekend && !isPeak(beijingTodayAt(now, 10));
	const period = peakPricing ? (peak ? "peak" : "idle") : "flat";
	const reason = !peakPricing ? "flat" : peak ? "peak-window" : weekend ? "weekend" : holiday ? "holiday" : "off-window";
	return {
		now,
		day: beijingDayKey(now),
		weekday,
		era: era.id,
		pricing: peakPricing ? "peak-idle" : "flat",
		peak,
		period,
		reason,
		// Windows only apply on a peak-priced week day; weekends/holidays are idle
		// around the clock, so there is nothing to show.
		windows: peakPricing && !weekend && !holiday ? PEAK_WINDOWS : [],
		prices: {
			currency: "CNY",
			flash: priceRow(now, "deepseek-flash"),
			pro: priceRow(now, "deepseek-pro")
		},
		next: peakPricing ? nextBoundary(now, peak) : null
	};
}
