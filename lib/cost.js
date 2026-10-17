/**
 * dsh-usage-stats — session cost estimation from the official DeepSeek price
 * eras. Kept free of cordis imports so it can be unit-tested outside the
 * running harness (same convention as usage.js).
 *
 * Billing facts this module encodes (all prices are CNY per million tokens,
 * published by DeepSeek; each value is verified against the account's own
 * platform billing for the same days):
 *
 *   - 2026-08-17 00:00 Beijing — first peak/valley price table (V4 series):
 *     V4-Flash idle 0.05 / 1.5 / 4.5, peak 0.10 / 3.0 / 9.0;
 *     V4-Pro  idle 0.15 / 4.5 / 13.5, peak 0.30 / 9.0 / 27.0.
 *     Peak hours are 09:00–12:00 and 14:00–18:00 Beijing time every day.
 *   - 2026-08-23 00:00 — Saturday/Sunday become all-day valley (idle).
 *   - 2026-09-10 12:00 — V4.1-Flash price cut: idle 0.02 / 1.0 / 4.0,
 *     peak 0.04 / 2.0 / 8.0; peak hours are WORKDAYS only (weekends idle),
 *     and the legacy names deepseek-v4-flash / deepseek-v4-flash-vision-exp
 *     are routed to the same Flash price.
 *   - 2026-09-14 12:00 — the planned V4-Pro → V4.1 Flash routing was
 *     cancelled by DeepSeek (2026-09-11 announcement), so Pro keeps its own
 *     price row; no Pro usage is priced as Flash.
 *   - 2026-09-19 — adjusted-work weekends and Chinese statutory holidays are
 *     all-day idle (the holiday dates below are the confirmed 2026 ones).
 *   - 2026-10-17 — V4.1-Flash-1017 ships with unchanged prices.
 *   - Before 2026-08-17 the price was flat (no peak/valley): V4-Flash
 *     0.02 / 1.0 / 2.0, V4-Pro 0.025 / 3.0 / 6.0.
 *
 * The estimate is a price-table calculation, not a bill: the account's own
 * platform billing stays authoritative. Cache-write tokens ride the cache-miss
 * price (DeepSeek has no separate cache-write line item).
 *
 * @module dsh-usage-stats/cost
 */

/** Currency every price below is expressed in. */
export const COST_CURRENCY = "CNY";

const HOUR_MS = 3600000;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;

/** Beijing wall-clock epoch: epoch → (utc fields shifted by +8h). */
function beijingParts(timeMs) {
	const shifted = new Date(timeMs + BEIJING_OFFSET_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
		weekday: shifted.getUTCDay() // 0 = Sunday
	};
}

/** Beijing epoch ms for a Beijing wall-clock date/time. */
function beijingEpoch(year, month, day, hour = 0, minute = 0) {
	return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS;
}

/** Era boundaries (Beijing wall-clock). */
export const PRICE_ERAS = [
	{
		id: "v4-flat",
		from: 0,
		to: beijingEpoch(2026, 8, 17),
		peak: false,
		flash: { hit: 0.02, miss: 1.0, out: 2.0 },
		pro: { hit: 0.025, miss: 3.0, out: 6.0 }
	},
	{
		id: "v4-peak",
		from: beijingEpoch(2026, 8, 17),
		to: beijingEpoch(2026, 9, 10, 12),
		peak: true,
		flash: {
			idle: { hit: 0.05, miss: 1.5, out: 4.5 },
			peak: { hit: 0.1, miss: 3.0, out: 9.0 }
		},
		pro: {
			idle: { hit: 0.15, miss: 4.5, out: 13.5 },
			peak: { hit: 0.3, miss: 9.0, out: 27.0 }
		}
	},
	{
		id: "v4.1-flash",
		from: beijingEpoch(2026, 9, 10, 12),
		to: beijingEpoch(2026, 10, 17),
		peak: true,
		flash: {
			idle: { hit: 0.02, miss: 1.0, out: 4.0 },
			peak: { hit: 0.04, miss: 2.0, out: 8.0 }
		},
		pro: {
			idle: { hit: 0.15, miss: 4.5, out: 13.5 },
			peak: { hit: 0.3, miss: 9.0, out: 27.0 }
		}
	},
	{
		id: "v4.1-flash-1017",
		from: beijingEpoch(2026, 10, 17),
		to: Infinity,
		peak: true,
		flash: {
			idle: { hit: 0.02, miss: 1.0, out: 4.0 },
			peak: { hit: 0.04, miss: 2.0, out: 8.0 }
		},
		pro: {
			idle: { hit: 0.15, miss: 4.5, out: 13.5 },
			peak: { hit: 0.3, miss: 9.0, out: 27.0 }
		}
	}
];

/** Weekends became all-day idle at this Beijing instant (2026-08-23 00:00). */
const WEEKEND_IDLE_FROM = beijingEpoch(2026, 8, 23);

/**
 * Confirmed 2026 Chinese statutory holidays inside the priced window (the
 * official 2026 arrangement: Mid-Autumn Sep 25–27, National Day Oct 1–7, with
 * Sep 20 and Oct 10 as adjusted workdays that the platform still bills idle).
 */
const HOLIDAYS = new Set([
	"2026-09-25",
	"2026-09-26",
	"2026-09-27",
	"2026-10-01",
	"2026-10-02",
	"2026-10-03",
	"2026-10-04",
	"2026-10-05",
	"2026-10-06",
	"2026-10-07"
]);

/** `YYYY-MM-DD` of a Beijing wall-clock epoch. */
export function beijingDayKey(timeMs) {
	const p = beijingParts(timeMs);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The price era active at `timeMs`. */
export function eraOf(timeMs) {
	for (const era of PRICE_ERAS) {
		if (timeMs >= era.from && timeMs < era.to) return era;
	}
	return PRICE_ERAS[PRICE_ERAS.length - 1];
}

/**
 * Whether `timeMs` falls in a peak-priced window. The rule has changed over
 * time: before 2026-08-17 everything was flat-priced; afterwards the peak
 * windows apply every day, then weekends go idle (2026-08-23), then holidays
 * and adjusted-work weekends go idle as well (2026-09-19, when the current
 * workday-only rule was published).
 * @param timeMs - event time (epoch ms).
 * @returns true only when the sample is billed at the peak price.
 */
export function isPeak(timeMs) {
	const era = eraOf(timeMs);
	if (era.peak !== true) return false;
	const p = beijingParts(timeMs);
	const weekend = p.weekday === 0 || p.weekday === 6;
	if (weekend) {
		// 2026-08-17..2026-08-22 still charged peak windows on Saturdays and
		// Sundays; from 2026-08-23 the whole weekend is idle.
		if (timeMs >= WEEKEND_IDLE_FROM) return false;
	}
	if (!weekend && HOLIDAYS.has(`${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`)) return false;
	const minutes = p.hour * 60 + p.minute;
	return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/** `deepseek-v4-pro`/`…pro…` → pro class; every Flash lineage model → flash. */
export function modelClassOf(model) {
	return typeof model === "string" && /pro/i.test(model) ? "pro" : "flash";
}

/**
 * The price row that applies to one sample.
 * @param timeMs - event time.
 * @param model - model id (e.g. `deepseek-v4-flash-vision-exp`).
 * @returns `{ hit, miss, out, period }` — CNY per million tokens and the
 *   billing period (`peak` / `idle` / `flat`); or null when the era names no
 *   price for that model class.
 */
export function priceFor(timeMs, model) {
	const era = eraOf(timeMs);
	if (era.peak !== true) {
		const row = era[modelClassOf(model)];
		return row === void 0 ? null : { ...row, period: "flat" };
	}
	const period = isPeak(timeMs) ? "peak" : "idle";
	const klass = modelClassOf(model);
	const row = era[klass]?.[period];
	return row === void 0 ? null : { ...row, period };
}

/** Billing buckets of one usage sample (`cacheWrite` rides the miss price). */
export function bucketsOf(usage) {
	return {
		hitTokens: usage?.cacheReadTokens ?? 0,
		missTokens: usage?.inputTokens ?? 0,
		writeTokens: usage?.cacheWriteTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0
	};
}

/** Total billed tokens of one bucket set. */
export function tokensOf(buckets) {
	return buckets.hitTokens + buckets.missTokens + buckets.writeTokens + buckets.outputTokens;
}

/**
 * Cost of one sample in CNY.
 * @returns `{ cost, priced, period }`; `priced` is false when no price row
 *   exists for the sample's era/model (the tokens are still counted).
 */
export function costOfSample(buckets, timeMs, model) {
	const price = priceFor(timeMs, model);
	if (price === null) return { cost: 0, priced: false, period: "unknown" };
	const promptMiss = buckets.missTokens + buckets.writeTokens;
	const cost =
		(buckets.hitTokens * price.hit + promptMiss * price.miss + buckets.outputTokens * price.out) / 1000000;
	return { cost, priced: true, period: price.period };
}

/** Empty mutable fold state for ONE session. */
export function createCostState() {
	return {
		totals: {
			hitTokens: 0,
			missTokens: 0,
			writeTokens: 0,
			outputTokens: 0,
			tokens: 0,
			cost: 0,
			pricedTokens: 0,
			samples: 0
		},
		periods: {
			peak: { tokens: 0, cost: 0 },
			idle: { tokens: 0, cost: 0 },
			flat: { tokens: 0, cost: 0 }
		},
		models: new Map(),
		turns: new Map(),
		lastSample: null,
		currentModel: null
	};
}

function addInto(target, buckets, tokens) {
	target.hitTokens += buckets.hitTokens;
	target.missTokens += buckets.missTokens;
	target.writeTokens += buckets.writeTokens;
	target.outputTokens += buckets.outputTokens;
	target.tokens += tokens;
	return target;
}

function subtractFrom(target, buckets, tokens) {
	target.hitTokens -= buckets.hitTokens;
	target.missTokens -= buckets.missTokens;
	target.writeTokens -= buckets.writeTokens;
	target.outputTokens -= buckets.outputTokens;
	target.tokens -= tokens;
	return target;
}

function periodBucket(state, period) {
	const bucket = state.periods[period];
	return bucket === void 0 ? state.periods.idle : bucket;
}

function modelBucket(state, model) {
	let bucket = state.models.get(model);
	if (bucket === void 0) {
		bucket = { tokens: 0, cost: 0, priced: false };
		state.models.set(model, bucket);
	}
	return bucket;
}

/**
 * Per-turn bucket (turn number → tokens/cost/time window). The window feeds the
 * "cost of this turn" display in the per-turn usage dialog; child sessions are
 * attributed to the turn that was running when they were created.
 */
function turnBucket(state, turn) {
	const key = typeof turn === "number" ? turn : Number(turn);
	if (!Number.isFinite(key)) return null;
	let bucket = state.turns.get(key);
	if (bucket === void 0) {
		bucket = { turn: key, tokens: 0, cost: 0, startTime: void 0, endTime: void 0 };
		state.turns.set(key, bucket);
	}
	return bucket;
}

/** The usage sample an event carries, if any (mirrors usage.js semantics). */
function sampleOf(event) {
	if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
		return { key: `${event.data.turn}:${event.data.step}`, turn: event.data.turn, usage: event.data.chunk.usage };
	}
	if (event.type === "assistant/message" && event.data?.usage !== void 0) {
		return { key: `${event.data.turn}:${event.data.step}`, turn: event.data.turn, usage: event.data.usage };
	}
	return void 0;
}

/** Provider/model attribution of a sample (same rule as usage.js). */
function modelOf(event) {
	const source = event.data?.message?.source;
	if (source !== void 0 && typeof source.model === "string") return source.model;
	const config = event.data?.header?.config;
	if (config !== void 0 && typeof config.model === "string") return config.model;
	return void 0;
}

/**
 * Fold a slice of new events onto a session cost state (mutating).
 * A repeated (turn, step) sample REPLACES the earlier one instead of double
 * counting it, so a live session's streaming usage and its final assistant
 * message stay exact.
 * @param state - session cost state (mutated in place).
 * @param events - new events in seq order.
 */
export function applyCostDelta(state, events) {
	let last = state.lastSample;
	let currentModel = state.currentModel;
	for (const event of events) {
		if (event.type === "request/header") {
			const model = modelOf(event);
			if (model !== void 0) currentModel = model;
		}
		const sample = sampleOf(event);
		if (sample === void 0) continue;
		const buckets = bucketsOf(sample.usage);
		const tokens = tokensOf(buckets);
		const model = modelOf(event) ?? currentModel ?? "unknown";
		const timeMs = typeof event.time === "number" ? event.time : 0;
		const evaluated = costOfSample(buckets, timeMs, model);
		const period = evaluated.period === "unknown" ? "idle" : evaluated.period;
		if (last !== null && last.key === sample.key) {
			const previous = last;
			subtractFrom(state.totals, previous.buckets, previous.tokens);
			state.totals.cost -= previous.cost;
			if (previous.priced) state.totals.pricedTokens -= previous.tokens;
			const previousPeriod = periodBucket(state, previous.period);
			previousPeriod.tokens -= previous.tokens;
			previousPeriod.cost -= previous.cost;
			const previousModel = modelBucket(state, previous.model);
			previousModel.tokens -= previous.tokens;
			previousModel.cost -= previous.cost;
			const previousTurn = previous.turn === void 0 ? null : turnBucket(state, previous.turn);
			if (previousTurn !== null) {
				previousTurn.tokens -= previous.tokens;
				previousTurn.cost -= previous.cost;
			}
			state.totals.samples -= 1;
		}
		addInto(state.totals, buckets, tokens);
		state.totals.cost += evaluated.cost;
		if (evaluated.priced) state.totals.pricedTokens += tokens;
		const periodEntry = periodBucket(state, period);
		periodEntry.tokens += tokens;
		periodEntry.cost += evaluated.cost;
		const modelEntry = modelBucket(state, model);
		modelEntry.tokens += tokens;
		modelEntry.cost += evaluated.cost;
		if (evaluated.priced) modelEntry.priced = true;
		const turnEntry = sample.turn === void 0 ? null : turnBucket(state, sample.turn);
		if (turnEntry !== null) {
			turnEntry.tokens += tokens;
			turnEntry.cost += evaluated.cost;
			if (turnEntry.startTime === void 0 || timeMs < turnEntry.startTime) turnEntry.startTime = timeMs;
			if (turnEntry.endTime === void 0 || timeMs > turnEntry.endTime) turnEntry.endTime = timeMs;
		}
		state.totals.samples += 1;
		last = {
			key: sample.key,
			turn: sample.turn,
			buckets,
			tokens,
			model,
			period,
			cost: evaluated.cost,
			priced: evaluated.priced
		};
	}
	state.lastSample = last;
	state.currentModel = currentModel;
}

/** Prompt-side cache hit rate in percent (one decimal), or null. */
export function cacheHitRate(totals) {
	const prompt = totals.hitTokens + totals.missTokens + totals.writeTokens;
	if (prompt <= 0) return null;
	return Math.round((totals.hitTokens / prompt) * 1000) / 10;
}

/**
 * Render one session's cost state into the wire shape: bucket totals, cache
 * hit rate, cost split by billing period, per-model rows, and per-turn rows.
 */
export function renderCost(state) {
	const totals = state.totals;
	const models = [...state.models.entries()]
		.map(([model, entry]) => ({
			model,
			tokens: entry.tokens,
			cost: Math.round(entry.cost * 10000) / 10000,
			priced: entry.priced
		}))
		.filter((entry) => entry.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);
	const turns = [...state.turns.values()]
		.filter((entry) => entry.tokens > 0 || entry.cost > 0)
		.sort((a, b) => a.turn - b.turn)
		.map((entry) => ({
			turn: entry.turn,
			tokens: entry.tokens,
			cost: Math.round(entry.cost * 10000) / 10000,
			startTime: entry.startTime,
			endTime: entry.endTime
		}));
	return {
		tokens: totals.tokens,
		hitTokens: totals.hitTokens,
		missTokens: totals.missTokens,
		writeTokens: totals.writeTokens,
		outputTokens: totals.outputTokens,
		cacheHitRate: cacheHitRate(totals),
		samples: totals.samples,
		pricedTokens: totals.pricedTokens,
		cost: Math.round(totals.cost * 10000) / 10000,
		currency: COST_CURRENCY,
		peakTokens: state.periods.peak.tokens,
		peakCost: Math.round(state.periods.peak.cost * 10000) / 10000,
		idleTokens: state.periods.idle.tokens,
		idleCost: Math.round(state.periods.idle.cost * 10000) / 10000,
		flatTokens: state.periods.flat.tokens,
		flatCost: Math.round(state.periods.flat.cost * 10000) / 10000,
		models,
		turns
	};
}
