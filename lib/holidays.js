/**
 * dsh-usage-stats — automatic Chinese statutory-holiday calendar.
 *
 * `lib/cost.js` prices peak/idle windows from a holiday set; this module keeps
 * that set current without shipping a yearly release: it fetches public
 * holiday calendars (year-scoped dates only, no credentials), caches them under
 * `<DSH_HOME>/storages/usage-stats-holidays.json`, and feeds the union into
 * `setHolidayCalendar()`. The built-in 2026 set in cost.js stays as the offline
 * fallback, so a failed sync can only miss a newly announced holiday — it never
 * drops the known ones.
 *
 * Sources (tried in order, both plain JSON over HTTPS):
 *   - timor.tech  `/api/holiday/year/<year>` — `{ holiday: { "MM-DD": { holiday, date } } }`
 *   - jiejiariapi `/v1/holidays/<year>`      — `{ "YYYY-MM-DD": { isOffDay } }`
 *
 * Refresh policy: current year ± 1 are refreshed weekly; older years are
 * immutable and fetched once (so historical cost estimates keep the right
 * holidays). Callers run this in the background; it never blocks a request.
 *
 * @module dsh-usage-stats/holidays
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { holidayCalendarDates, setHolidayCalendar } from "./cost.js";

const CACHE_VERSION = 1;
/** Current-year data can change when the State Council publishes adjustments. */
const REFRESH_MS = 7 * 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Cache file: `<DSH_HOME>/storages/usage-stats-holidays.json`. */
function cachePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "usage-stats-holidays.json");
}

/** Public holiday sources, in fallback order. */
const SOURCES = [
	{
		name: "timor.tech",
		url: (year) => `https://timor.tech/api/holiday/year/${year}`,
		parse: (payload, year) => {
			const table = payload?.holiday;
			if (table === null || typeof table !== "object") throw new Error("timor calendar: missing holiday table");
			const dates = new Set();
			for (const [key, value] of Object.entries(table)) {
				if (value?.holiday !== true) continue;
				const date = typeof value.date === "string" && DATE_RE.test(value.date) ? value.date : `${year}-${key}`;
				if (date.startsWith(`${year}-`) && DATE_RE.test(date)) dates.add(date);
			}
			return [...dates].sort();
		}
	},
	{
		name: "jiejiariapi",
		url: (year) => `https://api.jiejiariapi.com/v1/holidays/${year}`,
		parse: (payload, year) => {
			if (payload === null || typeof payload !== "object") throw new Error("jiejiariapi: unexpected payload");
			const dates = new Set();
			for (const [date, value] of Object.entries(payload)) {
				if (value?.isOffDay !== true || !DATE_RE.test(date)) continue;
				if (date.startsWith(`${year}-`)) dates.add(date);
			}
			return [...dates].sort();
		}
	}
];

/** `{ years: { "2026": { dates, fetchedAt, source } }, updatedAt, source }` */
let cacheState = { years: {}, updatedAt: null, source: "builtin" };

/** Info exposed by the price-period route for the UI tooltip. */
export function holidayCalendarInfo() {
	const years = Object.keys(cacheState.years).sort();
	return {
		updatedAt: cacheState.updatedAt,
		source: cacheState.source,
		years,
		holidays: holidayCalendarDates().length,
		builtin: cacheState.source === "builtin"
	};
}

/** Apply every cached year (plus the built-in set) to the pricing engine. */
function applyCache() {
	const dates = [];
	for (const entry of Object.values(cacheState.years)) {
		for (const date of entry.dates) dates.push(date);
	}
	setHolidayCalendar(dates);
}

/** Normalize whatever is on disk; never throws (a broken file is a cache miss). */
function normalizeCache(raw) {
	if (raw === null || typeof raw !== "object" || raw.version !== CACHE_VERSION) return null;
	const years = {};
	for (const [year, entry] of Object.entries(raw.years ?? {})) {
		if (!/^\d{4}$/.test(year) || entry === null || typeof entry !== "object") continue;
		const dates = Array.isArray(entry.dates) ? entry.dates.filter((date) => typeof date === "string" && DATE_RE.test(date)) : [];
		if (dates.length === 0 && entry.source === void 0) continue;
		years[year] = {
			dates,
			fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0,
			source: typeof entry.source === "string" ? entry.source : "unknown"
		};
	}
	return {
		version: CACHE_VERSION,
		years,
		updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
		source: typeof raw.source === "string" ? raw.source : "builtin"
	};
}

/**
 * Read the cached calendar and apply it to the pricing engine.
 * @returns the applied info (builtin when there is no usable cache).
 */
export async function loadHolidayCache() {
	try {
		const parsed = normalizeCache(JSON.parse(await readFile(cachePath(), "utf8")));
		if (parsed !== null) {
			cacheState = parsed;
			applyCache();
		}
	} catch {
		/* no cache yet / unreadable: the built-in set stays active */
	}
	return holidayCalendarInfo();
}

async function writeCache() {
	const path = cachePath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify({
		version: CACHE_VERSION,
		years: cacheState.years,
		updatedAt: cacheState.updatedAt,
		source: cacheState.source
	}), "utf8");
	await rename(temporary, path);
}

/** One source request; throws on HTTP/parse failure. */
async function fetchYear(source, year, { fetchImpl, timeoutMs }) {
	const response = await fetchImpl(source.url(year), {
		headers: { accept: "application/json" },
		signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : void 0
	});
	if (response.ok !== true) throw new Error(`${source.name} HTTP ${response.status}`);
	const payload = await response.json();
	return source.parse(payload, year);
}

/**
 * Refresh the calendar from the network, merge into the cache, persist it and
 * apply it to the pricing engine. Failures are reported per year but never
 * thrown: the caller is a background sync.
 * @param options - `{ fetchImpl, now, timeoutMs, years, force }`.
 * @returns `{ info, fetched, failures }`.
 */
export async function refreshHolidayCalendar(options = {}) {
	const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : FETCH_TIMEOUT_MS;
	const currentYear = new Date(now + 8 * 3600 * 1000).getUTCFullYear();
	const years = Array.isArray(options.years) && options.years.length > 0
		? options.years.map(Number).filter(Number.isInteger)
		: [currentYear - 1, currentYear, currentYear + 1];
	const force = options.force === true;
	const fetched = [];
	const failures = [];
	let changed = false;

	for (const year of years) {
		const key = String(year);
		const cached = cacheState.years[key];
		const stale = cached === void 0 || cached.fetchedAt === 0 || (year >= currentYear - 1 && now - cached.fetchedAt >= REFRESH_MS);
		if (!stale && !force) continue;
		let stored = false;
		for (const source of SOURCES) {
			try {
				const dates = await fetchYear(source, year, { fetchImpl, timeoutMs });
				cacheState.years[key] = { dates, fetchedAt: now, source: source.name };
				cacheState.updatedAt = now;
				cacheState.source = source.name;
				fetched.push({ year, source: source.name, dates: dates.length });
				changed = true;
				stored = true;
				break;
			} catch (error) {
				failures.push({ year, source: source.name, message: error instanceof Error ? error.message : String(error) });
			}
		}
		if (!stored && cached !== void 0) {
			// Keep the previous data for this year; only the sync attempt failed.
			continue;
		}
	}

	if (changed) {
		applyCache();
		try {
			await writeCache();
		} catch (error) {
			failures.push({ year: null, source: "cache", message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { info: holidayCalendarInfo(), fetched, failures };
}
