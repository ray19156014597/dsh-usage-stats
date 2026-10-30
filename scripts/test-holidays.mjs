// Holiday-calendar sync tests: parsing, caching, fallback source, stale policy.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "dsh-holidays-"));
process.env.DSH_HOME = home;

const { refreshHolidayCalendar, loadHolidayCache, holidayCalendarInfo } = await import("../lib/holidays.js");
const { isPeak, holidayCalendarDates, setHolidayCalendar } = await import("../lib/cost.js");

const now = Date.UTC(2026, 9, 30, 14, 0) - 8 * 3600000; // 2026-10-30 22:00 Beijing
const bj = (year, month, day, hour = 0) => Date.UTC(year, month - 1, day, hour) - 8 * 3600000;

const timorPayload = {
	code: 0,
	holiday: {
		"11-02": { holiday: true, name: "测试假日", date: "2026-11-02" },
		"09-20": { holiday: false, name: "补班", date: "2026-09-20" },
		"10-01": { holiday: true, name: "国庆节", date: "2026-10-01" }
	}
};
const jiejiariapiPayload = {
	"2026-12-25": { date: "2026-12-25", name: "测试假日", isOffDay: true },
	"2026-12-26": { date: "2026-12-26", name: "测试补班", isOffDay: false }
};

function jsonResponse(payload) {
	return { ok: true, status: 200, json: async () => payload };
}

try {
	// 1) Primary source: holiday=true entries become idle days; workday entries do not.
	let calls = 0;
	const primary = await refreshHolidayCalendar({
		years: [2026],
		now,
		fetchImpl: async (url) => {
			calls += 1;
			assert.ok(String(url).includes("timor.tech"), `unexpected primary url ${url}`);
			return jsonResponse(timorPayload);
		}
	});
	assert.equal(calls, 1);
	assert.equal(primary.fetched.length, 1);
	assert.equal(primary.fetched[0].source, "timor.tech");
	assert.deepEqual(primary.fetched[0].dates, 2, "only holiday=true dates count");
	assert.equal(primary.info.source, "timor.tech");
	assert.equal(primary.info.updatedAt, now);
	assert.equal(isPeak(bj(2026, 11, 2, 10)), false, "synced holiday must be idle at 10:00");
	assert.equal(isPeak(bj(2026, 10, 30, 10)), true, "normal weekday keeps its peak window");

	// 2) Cache round-trip: a fresh load reapplies the same dates.
	const info = await loadHolidayCache();
	assert.equal(info.source, "timor.tech");
	assert.ok(holidayCalendarDates().includes("2026-11-02"));

	// 3) Fresh cache is honored: a second refresh within the TTL performs no request.
	let skipped = 0;
	await refreshHolidayCalendar({
		years: [2026],
		now: now + 24 * 3600 * 1000,
		fetchImpl: async () => {
			skipped += 1;
			return jsonResponse(timorPayload);
		}
	});
	assert.equal(skipped, 0, "a fresh cache must not hit the network");

	// 4) A week later the year is stale again; a failing primary falls back to source #2.
	const fallback = await refreshHolidayCalendar({
		years: [2026],
		now: now + 8 * 24 * 3600 * 1000,
		fetchImpl: async (url) => {
			if (String(url).includes("timor.tech")) throw new Error("primary down");
			return jsonResponse(jiejiariapiPayload);
		}
	});
	assert.equal(fallback.fetched[0].source, "jiejiariapi");
	assert.equal(fallback.info.source, "jiejiariapi");
	assert.equal(isPeak(bj(2026, 12, 25, 10)), false, "fallback holiday must be idle");

	// 5) All sources failing keeps the previous cache and only reports failures.
	const failed = await refreshHolidayCalendar({
		years: [2026],
		now: now + 16 * 24 * 3600 * 1000,
		fetchImpl: async () => {
			throw new Error("offline");
		}
	});
	assert.equal(failed.fetched.length, 0);
	assert.equal(failed.failures.length, 2, "both sources must be reported");
	assert.equal(isPeak(bj(2026, 12, 25, 10)), false, "cached holidays survive a failed sync");

	// 6) A source answering for the wrong year must not leak dates into the calendar.
	const wrongYear = await refreshHolidayCalendar({
		years: [2027],
		now: now + 20 * 24 * 3600 * 1000,
		fetchImpl: async (url) => {
			if (String(url).includes("timor.tech")) {
				return jsonResponse({ holiday: { "01-01": { holiday: true, date: "2026-01-01" } } });
			}
			throw new Error("secondary down");
		}
	});
	assert.equal(wrongYear.fetched[0].dates, 0, "wrong-year dates are filtered out");
	assert.ok(holidayCalendarInfo().years.includes("2027"), "the year is still recorded");

	console.log("holiday calendar sync tests passed");
} finally {
	setHolidayCalendar([]);
	await rm(home, { recursive: true, force: true });
}
