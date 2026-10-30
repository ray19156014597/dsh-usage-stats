// Unit tests for the live peak/idle billing indicator (pure schedule logic).
import assert from "node:assert/strict";
import { describePricePeriod } from "../lib/price-period.js";

/** Beijing wall-clock epoch. */
const bj = (year, month, day, hour = 0, minute = 0) => Date.UTC(year, month - 1, day, hour, minute) - 8 * 3600000;
const at = (epoch) => describePricePeriod(epoch);

// Friday 22:43 → idle, next peak is Monday 09:00 (the weekend is idle all day).
{
	const state = at(bj(2026, 10, 30, 22, 43));
	assert.equal(state.period, "idle");
	assert.equal(state.reason, "off-window");
	assert.equal(state.era, "v4.1-flash-1017");
	assert.equal(state.weekday, 5);
	assert.deepEqual(state.windows, [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }]);
	assert.deepEqual(state.prices.flash, { hit: 0.02, miss: 1, out: 4 }, "idle Flash row");
	assert.deepEqual(state.prices.pro, { hit: 0.15, miss: 4.5, out: 13.5 }, "idle Pro row");
	assert.equal(state.next.period, "peak");
	assert.equal(state.next.at, bj(2026, 11, 2, 9, 0), "weekend skips straight to Monday 09:00");
}

// Weekday 10:00 → peak, next change is 12:00.
{
	const state = at(bj(2026, 10, 30, 10, 0));
	assert.equal(state.period, "peak");
	assert.equal(state.reason, "peak-window");
	assert.deepEqual(state.prices.flash, { hit: 0.04, miss: 2, out: 8 }, "peak Flash row");
	assert.equal(state.next.period, "idle");
	assert.equal(state.next.at, bj(2026, 10, 30, 12, 0));
}

// Lunch break 13:00 → idle, next peak 14:00; 17:59 → peak, next idle 18:00.
{
	const lunch = at(bj(2026, 10, 30, 13, 0));
	assert.equal(lunch.period, "idle");
	assert.equal(lunch.next.at, bj(2026, 10, 30, 14, 0));
	const late = at(bj(2026, 10, 30, 17, 59));
	assert.equal(late.period, "peak");
	assert.equal(late.next.at, bj(2026, 10, 30, 18, 0));
}

// Weekend 10:00 → idle all day; next peak Monday 09:00.
{
	const state = at(bj(2026, 10, 31, 10, 0));
	assert.equal(state.period, "idle");
	assert.equal(state.reason, "weekend");
	assert.deepEqual(state.windows, [], "no windows on an idle weekend");
	assert.equal(state.next.at, bj(2026, 11, 2, 9, 0));
}

// National Day (2026-10-01) → holiday idle; next peak 2026-10-08 09:00.
{
	const state = at(bj(2026, 10, 1, 10, 0));
	assert.equal(state.period, "idle");
	assert.equal(state.reason, "holiday");
	assert.deepEqual(state.windows, []);
	assert.equal(state.next.at, bj(2026, 10, 8, 9, 0), "the whole holiday run stays idle");
}

// Pre-2026-08-17 price table has no peak pricing at all.
{
	const state = at(bj(2026, 8, 1, 10, 0));
	assert.equal(state.period, "flat");
	assert.equal(state.reason, "flat");
	assert.equal(state.pricing, "flat");
	assert.equal(state.next, null);
	assert.deepEqual(state.prices.flash, { hit: 0.02, miss: 1, out: 2 }, "legacy flat Flash row");
}

// Boundary minutes are inclusive of the next window start.
{
	assert.equal(at(bj(2026, 10, 30, 12, 0)).period, "idle", "12:00 is already idle");
	assert.equal(at(bj(2026, 10, 30, 9, 0)).period, "peak", "09:00 starts the peak window");
	assert.equal(at(bj(2026, 10, 30, 14, 0)).period, "peak", "14:00 starts the afternoon window");
}

console.log("price period indicator tests passed");
