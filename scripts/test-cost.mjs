// Unit tests for lib/cost.js — the official price-era table, peak/valley
// windows, model mapping, and the replacement-aware fold. These assertions
// pin the facts that were verified against the account's own platform billing
// (docs/news: 2026-08-13 / 2026-08-21 / 2026-09-10 / 2026-09-19 / 2026-10-17).
import assert from "node:assert/strict";
import {
	applyCostDelta,
	beijingDayKey,
	cacheHitRate,
	costOfSample,
	createCostState,
	eraOf,
	isPeak,
	modelClassOf,
	priceFor,
	renderCost
} from "../lib/cost.js";

/** Beijing wall-clock instant → epoch ms. */
function beijing(year, month, day, hour = 0, minute = 0) {
	return Date.UTC(year, month - 1, day, hour, minute) - 8 * 3600 * 1000;
}

/** A usage sample event as the session log stores it. */
function sample(time, turn, step, usage, model = "deepseek-flash") {
	return { type: "assistant/message", time, data: { turn, step, usage, message: { role: "assistant", source: { model } } } };
}

// ---- price eras -----------------------------------------------------------
assert.equal(eraOf(beijing(2026, 8, 16, 23, 59)).id, "v4-flat");
assert.equal(eraOf(beijing(2026, 8, 17, 0, 0)).id, "v4-peak");
assert.equal(eraOf(beijing(2026, 9, 10, 11, 59)).id, "v4-peak");
assert.equal(eraOf(beijing(2026, 9, 10, 12, 0)).id, "v4.1-flash");
assert.equal(eraOf(beijing(2026, 10, 17, 0, 0)).id, "v4.1-flash-1017");

// ---- pre-peak flat era (2026-08-15/16 of the current session) -------------
assert.deepEqual(priceFor(beijing(2026, 8, 16, 23, 0), "deepseek-v4-flash"), { hit: 0.02, miss: 1, out: 2, period: "flat" });
assert.deepEqual(priceFor(beijing(2026, 8, 16, 23, 0), "deepseek-v4-pro"), { hit: 0.025, miss: 3, out: 6, period: "flat" });
assert.equal(isPeak(beijing(2026, 8, 16, 10, 0)), false, "flat era has no peak price");

// ---- v4 peak era: peak windows apply every day until 2026-08-23 -----------
assert.equal(isPeak(beijing(2026, 8, 17, 10, 0)), true);
assert.equal(isPeak(beijing(2026, 8, 17, 13, 0)), false);
assert.equal(isPeak(beijing(2026, 8, 17, 15, 0)), true);
assert.equal(isPeak(beijing(2026, 8, 22, 10, 0)), true, "until 08-23 even Saturdays keep peak windows");
assert.equal(isPeak(beijing(2026, 8, 23, 10, 0)), false, "weekends become all-day idle on 08-23");
assert.deepEqual(priceFor(beijing(2026, 8, 17, 10, 0), "deepseek-v4-flash"), { hit: 0.1, miss: 3, out: 9, period: "peak" });
assert.deepEqual(priceFor(beijing(2026, 8, 17, 10, 0), "deepseek-v4-pro"), { hit: 0.3, miss: 9, out: 27, period: "peak" });
assert.deepEqual(priceFor(beijing(2026, 9, 5, 3, 0), "deepseek-v4-flash-vision-exp"), { hit: 0.05, miss: 1.5, out: 4.5, period: "idle" });

// ---- v4.1 Flash prices from 2026-09-10 12:00 ------------------------------
assert.deepEqual(priceFor(beijing(2026, 9, 10, 12, 0), "deepseek-flash"), { hit: 0.02, miss: 1, out: 4, period: "idle" });
assert.deepEqual(priceFor(beijing(2026, 9, 11, 10, 0), "deepseek-flash"), { hit: 0.04, miss: 2, out: 8, period: "peak" });
assert.deepEqual(priceFor(beijing(2026, 9, 11, 10, 0), "deepseek-v4-pro"), { hit: 0.3, miss: 9, out: 27, period: "peak" },
	"the planned Pro→Flash routing was cancelled, so Pro keeps its own row");
assert.deepEqual(priceFor(beijing(2026, 10, 15, 10, 0), "deepseek-v4-flash"), { hit: 0.04, miss: 2, out: 8, period: "peak" },
	"v4.1-flash-1017 era keeps the 2026-09-10 prices");

// ---- holidays / adjusted workdays are idle --------------------------------
assert.equal(isPeak(beijing(2026, 10, 1, 10, 0)), false, "National Day is idle");
assert.equal(isPeak(beijing(2026, 9, 25, 10, 0)), false, "Mid-Autumn is idle");
assert.equal(isPeak(beijing(2026, 9, 20, 10, 0)), false, "adjusted workday Sunday is idle");
assert.equal(isPeak(beijing(2026, 10, 10, 10, 0)), false, "adjusted workday Saturday is idle");
assert.equal(isPeak(beijing(2026, 9, 29, 10, 0)), true, "ordinary Tuesday 10:00 is peak");
assert.equal(beijingDayKey(beijing(2026, 10, 17, 23, 30)), "2026-10-17");

// ---- model class ----------------------------------------------------------
for (const flash of ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash-expires-on-0910"]) {
	assert.equal(modelClassOf(flash), "flash", flash);
}
assert.equal(modelClassOf("deepseek-v4-pro"), "pro");
assert.equal(modelClassOf("unknown"), "flash", "unknown models fall back to the Flash price row");

// ---- per-sample math ------------------------------------------------------
const oneMillion = { hitTokens: 1000000, missTokens: 0, writeTokens: 0, outputTokens: 0 };
const idleFlash = costOfSample(oneMillion, beijing(2026, 10, 18, 2, 0), "deepseek-flash");
assert.equal(idleFlash.cost, 0.02);
assert.equal(idleFlash.period, "idle");
const peakFlash = costOfSample(oneMillion, beijing(2026, 9, 29, 10, 0), "deepseek-flash");
assert.equal(peakFlash.cost, 0.04);
assert.equal(peakFlash.period, "peak");
const missAndOut = costOfSample({ hitTokens: 0, missTokens: 500000, writeTokens: 500000, outputTokens: 1000000 }, beijing(2026, 10, 18, 2, 0), "deepseek-flash");
assert.equal(missAndOut.cost, 1 + 4, "cache-write rides the miss price");

// ---- replacement-aware fold ----------------------------------------------
const state = createCostState();
applyCostDelta(state, [
	sample(beijing(2026, 10, 18, 2, 0), 1, 1, { cacheReadTokens: 1000000, inputTokens: 0, outputTokens: 0 })
]);
let rendered = renderCost(state);
assert.equal(rendered.tokens, 1000000);
assert.equal(rendered.samples, 1);
assert.equal(rendered.cost, 0.02);
// The same (turn, step) re-reported: replaced, never double counted.
applyCostDelta(state, [
	sample(beijing(2026, 10, 18, 2, 1), 1, 1, { cacheReadTokens: 2000000, inputTokens: 1000000, outputTokens: 1000000 })
]);
rendered = renderCost(state);
assert.equal(rendered.tokens, 4000000);
assert.equal(rendered.samples, 1);
assert.equal(rendered.cost, 0.04 + 1 + 4);
assert.equal(rendered.cacheHitRate, 66.7);
assert.equal(rendered.idleTokens, 4000000);
assert.equal(rendered.peakTokens, 0);

// A different step accumulates on top.
applyCostDelta(state, [sample(beijing(2026, 10, 18, 2, 2), 1, 2, { cacheReadTokens: 0, inputTokens: 0, outputTokens: 1000000 })]);
rendered = renderCost(state);
assert.equal(rendered.samples, 2);
assert.equal(rendered.tokens, 5000000);
assert.equal(rendered.cost, 5.04 + 4);
assert.equal(rendered.models.length, 1);
assert.equal(rendered.models[0].model, "deepseek-flash");

// usage chunks replace their final assistant message sample as well.
const chunkState = createCostState();
applyCostDelta(chunkState, [
	{ type: "assistant/chunk", time: beijing(2026, 10, 18, 2, 0), data: { turn: 1, step: 1, chunk: { type: "usage", usage: { cacheReadTokens: 1000000 } } } },
	sample(beijing(2026, 10, 18, 2, 0), 1, 1, { cacheReadTokens: 1000000, inputTokens: 0, outputTokens: 0 })
]);
assert.equal(renderCost(chunkState).tokens, 1000000);

// cacheHitRate: prompt-side denominator, null when nothing billed.
assert.equal(cacheHitRate({ hitTokens: 0, missTokens: 0, writeTokens: 0 }), null);
assert.equal(cacheHitRate({ hitTokens: 999, missTokens: 1, writeTokens: 0 }), 99.9);

// ---- per-turn rows (drive the 本轮用量 dialog's cost row) -------------------
const turnState = createCostState();
applyCostDelta(turnState, [
	sample(beijing(2026, 10, 18, 2, 0), 1, 1, { cacheReadTokens: 1000000 }),
	sample(beijing(2026, 10, 18, 2, 5), 1, 2, { outputTokens: 1000000 }),
	sample(beijing(2026, 10, 18, 2, 30), 2, 1, { cacheReadTokens: 2000000 })
]);
let turnRendered = renderCost(turnState);
assert.equal(turnRendered.turns.length, 2);
assert.deepEqual(turnRendered.turns.map((row) => row.turn), [1, 2], "turns are ordered");
assert.equal(turnRendered.turns[0].tokens, 2000000);
assert.equal(turnRendered.turns[0].cost, 0.02 + 4, "turn 1 = 1M cache hit + 1M output at idle price");
assert.equal(turnRendered.turns[0].startTime, beijing(2026, 10, 18, 2, 0));
assert.equal(turnRendered.turns[0].endTime, beijing(2026, 10, 18, 2, 5));
assert.equal(turnRendered.turns[1].cost, 0.04);
// A re-reported (turn, step) replaces and is re-attributed between turn buckets.
applyCostDelta(turnState, [sample(beijing(2026, 10, 18, 2, 31), 2, 1, { cacheReadTokens: 3000000 })]);
turnRendered = renderCost(turnState);
assert.equal(turnRendered.turns[1].tokens, 3000000);
assert.equal(turnRendered.turns[1].cost, 0.06);

console.log("cost engine tests passed");
