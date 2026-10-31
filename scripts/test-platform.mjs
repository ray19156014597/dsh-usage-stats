// Regression tests for the DeepSeek platform usage monitor (lib/platform.js)
// and its /api/usage-stats/platform route in lib/index.js.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as platform from "../lib/platform.js";

// Real response shapes from platform.deepseek.com (see DeepSeekMonitorWindows).
const AMOUNT_FIXTURE = {
	data: {
		biz_data: {
			total: [
				{
					model: "deepseek-v4-flash",
					usage: [
						{ type: "REQUEST", amount: "12" },
						{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "3400000" },
						{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "120000" },
						{ type: "RESPONSE_TOKEN", amount: "96000" },
						{ type: "PROMPT_TOKEN", amount: "5000" }
					]
				},
				{
					model: "deepseek-v4-pro",
					usage: [
						{ type: "REQUEST", amount: "4" },
						{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "500000" },
						{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "80000" },
						{ type: "RESPONSE_TOKEN", amount: "30000" }
					]
				}
			],
			days: [
				{
					date: "2026-08-01",
					data: [
						{
							model: "deepseek-v4-flash",
							usage: [
								{ type: "REQUEST", amount: "6" },
								{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "1700000" },
								{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "60000" },
								{ type: "RESPONSE_TOKEN", amount: "48000" }
							]
						}
					]
				},
				{
					date: "2026-08-02",
					data: [
						{
							model: "deepseek-v4-pro",
							usage: [
								{ type: "REQUEST", amount: "4" },
								{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "500000" },
								{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "80000" },
								{ type: "RESPONSE_TOKEN", amount: "30000" }
							]
						}
					]
				}
			]
		}
	}
};

const COST_FIXTURE = {
	data: {
		biz_data: [
			{
				total: [
					{ model: "deepseek-v4-flash", usage: [{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "0.35" }, { type: "RESPONSE_TOKEN", amount: "1.2" }] },
					{ model: "deepseek-v4-pro", usage: [{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "2.5" }, { type: "RESPONSE_TOKEN", amount: "3.1" }] }
				],
				days: [
					{ date: "2026-08-01", data: [{ model: "deepseek-v4-flash", usage: [{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "0.18" }, { type: "RESPONSE_TOKEN", amount: "0.6" }] }] },
					{ date: "2026-08-02", data: [{ model: "deepseek-v4-pro", usage: [{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "2.5" }, { type: "RESPONSE_TOKEN", amount: "3.1" }] }] }
				]
			}
		]
	}
};

function okJson(body) {
	return { ok: true, status: 200, json: async () => body };
}

function errorJson(status) {
	return { ok: false, status, json: async () => ({}) };
}

function closeTo(actual, expected, epsilon = 1e-9) {
	assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

// Real per-API-Key response shape: by_api_key/amount & by_api_key/cost with
// epoch start/end + tz=28800 (buckets aligned to GMT+8 days).
function byKeyFixtures(month = 8, year = 2026) {
	const range = platform.monthRangeEpoch(month, year);
	const d1 = range.start;
	const d2 = range.start + 86400;
	const meta = (trackingId, name) => ({ tracking_id: trackingId, name, sensitive_id: `sk-${trackingId}****`, valid: true });
	return {
		amount: {
			data: {
				biz_data: {
					start: range.start,
					end: range.end,
					bucket: 86400,
					models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat & deepseek-reasoner"],
					series: [
						{ api_key: meta("tid-1", "Harness"), model: "deepseek-v4-flash", buckets: [
							{ time: d1, usage: { REQUEST: 12, PROMPT_CACHE_HIT_TOKEN: 3400000, PROMPT_CACHE_MISS_TOKEN: 120000, RESPONSE_TOKEN: 96000 } },
							{ time: d2, usage: { REQUEST: 6, PROMPT_CACHE_HIT_TOKEN: 1700000, PROMPT_CACHE_MISS_TOKEN: 60000, RESPONSE_TOKEN: 48000 } }
						] },
						{ api_key: meta("tid-2", "Codex"), model: "deepseek-v4-pro", buckets: [
							{ time: d2, usage: { REQUEST: 4, PROMPT_CACHE_HIT_TOKEN: 500000, PROMPT_CACHE_MISS_TOKEN: 80000, RESPONSE_TOKEN: 30000 } }
						] },
						{ api_key: meta("tid-1", "Harness"), model: "deepseek-chat & deepseek-reasoner", buckets: [
							{ time: d2, usage: { REQUEST: 3, PROMPT_CACHE_HIT_TOKEN: 100000, PROMPT_CACHE_MISS_TOKEN: 20000, RESPONSE_TOKEN: 10000 } }
						] },
						// All-zero series (e.g. a model with no usage) must be excluded from the aggregates.
						{ api_key: meta("tid-1", "Harness"), model: "deepseek-v4-flash-vision-exp", buckets: [
							{ time: d1, usage: { REQUEST: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0, RESPONSE_TOKEN: 0 } }
						] }
					]
				}
			}
		},
		cost: {
			data: {
				biz_data: {
					start: range.start,
					end: range.end,
					bucket: 86400,
					models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat & deepseek-reasoner"],
					data: [{
						currency: "CNY",
						series: [
							{ api_key: { tracking_id: "tid-1" }, model: "deepseek-v4-flash", buckets: [{ time: d1, cost: "0.35" }, { time: d2, cost: "0.60" }] },
							{ api_key: { tracking_id: "tid-2" }, model: "deepseek-v4-pro", buckets: [{ time: d2, cost: "2.50" }] },
							{ api_key: { tracking_id: "tid-1" }, model: "deepseek-chat & deepseek-reasoner", buckets: [{ time: d2, cost: "0.80" }] }
						]
					}]
				}
			}
		}
	};
}

/** Route fetch stubs correctly for by_api_key and legacy URLs. */
function platformFetchStub(upstreamCalls = [], upstreamAuth = []) {
	return async (url, init) => {
		const u = String(url);
		upstreamCalls.push(u);
		if (init?.headers?.authorization !== void 0) upstreamAuth.push(init.headers.authorization);
		const f = byKeyFixtures();
		if (u.includes("by_api_key/amount")) return okJson(f.amount);
		if (u.includes("by_api_key/cost")) return okJson(f.cost);
		if (u.includes("/usage/amount")) return okJson(AMOUNT_FIXTURE);
		if (u.includes("/usage/cost")) return okJson(COST_FIXTURE);
		throw new Error(`unexpected URL in stub: ${u}`);
	};
}

async function testParseAndBreakdown() {
	assert.deepEqual(platform.usageBreakdown(null), null);
	assert.equal(platform.usageBreakdown([]), null);
	const breakdown = platform.usageBreakdown([
		{ type: "REQUEST", amount: "3" },
		{ type: "PROMPT_CACHE_HIT_TOKEN", amount: "100" },
		{ type: "PROMPT_CACHE_MISS_TOKEN", amount: "40" },
		{ type: "RESPONSE_TOKEN", amount: "10" },
		{ type: "PROMPT_TOKEN", amount: "7" },
		{ type: "UNKNOWN_KIND", amount: "99" }
	]);
	assert.deepEqual(breakdown, { totalTokens: 157, requestCount: 3, cacheHitTokens: 100, cacheMissTokens: 40, responseTokens: 10 });
	assert.equal(platform.costOf([{ type: "REQUEST", amount: "999" }, { type: "PROMPT_TOKEN", amount: "0.5" }]), 0.5, "REQUEST entries are not billed");
	assert.equal(platform.modelNameOf("deepseek-v4-flash"), "V4 Flash");
	assert.equal(platform.modelNameOf("deepseek-v4-pro"), "V4 Pro");
	assert.equal(platform.modelNameOf("deepseek-chat"), "deepseek-chat", "unknown models keep their raw id");
	assert.throws(() => platform.normalizeMonthYear(13, 2026), /month must be 1-12/);
	assert.throws(() => platform.normalizeMonthYear(8, 1999), /year must be 2000-2100/);
	assert.deepEqual(platform.normalizeMonthYear(8, 2026), { month: 8, year: 2026 });
	const defaulted = platform.normalizeMonthYear(void 0, void 0, new Date(2026, 7, 15));
	assert.deepEqual(defaulted, { month: 8, year: 2026 }, "missing month/year default to the current month");
	console.log("platform parsing helpers ok");
}

async function testFetchNormalization() {
	const calls = [];
	const result = await platform.fetchPlatformUsage("token-123", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => {
			calls.push(url);
			return url.includes("/usage/amount") ? okJson(AMOUNT_FIXTURE) : okJson(COST_FIXTURE);
		}
	});
	assert.equal(calls.length, 2, "amount and cost must be fetched once each");
	assert.ok(calls.every((url) => url.includes("month=8&year=2026")));
	assert.equal(result.month, 8);
	assert.equal(result.year, 2026);
	assert.equal(result.models.length, 2);
	const flash = result.models.find((model) => model.key === "deepseek-v4-flash");
	assert.equal(flash.name, "V4 Flash");
	assert.equal(flash.requestCount, 12);
	assert.equal(flash.cacheHitTokens, 3400000);
	assert.equal(flash.cacheMissTokens, 120000);
	assert.equal(flash.responseTokens, 96000);
	assert.equal(flash.totalTokens, 3400000 + 120000 + 96000 + 5000);
	closeTo(flash.cost, 1.55);
	const pro = result.models.find((model) => model.key === "deepseek-v4-pro");
	assert.equal(pro.totalTokens, 500000 + 80000 + 30000);
	closeTo(pro.cost, 5.6);
	closeTo(result.monthCost, 7.15);
	assert.equal(result.days.length, 2);
	assert.equal(result.days[0].date, "2026-08-01");
	assert.equal(result.days[0].totalTokens, 1700000 + 60000 + 48000);
	closeTo(result.days[0].totalCost, 0.78);
	assert.equal(result.days[0].models["deepseek-v4-flash"].cacheHitTokens, 1700000);
	assert.equal(result.days[1].date, "2026-08-02");
	assert.equal(result.days[1].models["deepseek-v4-pro"].responseTokens, 30000);
	assert.ok(result.days[0].date < result.days[1].date, "days must be sorted ascending");
	console.log("platform fetch normalization ok");
}

async function testErrorMapping() {
	await assert.rejects(() => platform.fetchPlatformUsage("   ", { month: 8, year: 2026 }), (error) => error.providerStatus === "not-configured");
	await assert.rejects(() => platform.fetchPlatformUsage("token", {
		month: 8,
		year: 2026,
		fetchImpl: async () => errorJson(401)
	}), (error) => error.providerStatus === "unauthorized" && error.httpStatus === 401);
	await assert.rejects(() => platform.fetchPlatformUsage("token", {
		month: 8,
		year: 2026,
		fetchImpl: async () => errorJson(429)
	}), (error) => error.providerStatus === "rate-limited");
	await assert.rejects(() => platform.fetchPlatformUsage("token", {
		month: 8,
		year: 2026,
		fetchImpl: async () => errorJson(500)
	}), (error) => error.providerStatus === "unavailable");
	await assert.rejects(() => platform.fetchPlatformUsage("token", {
		month: 8,
		year: 2026,
		fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) })
	}), (error) => error.providerStatus === "invalid-response");
	console.log("platform error mapping ok");
}

async function testMonthRangeEpoch() {
	const r = platform.monthRangeEpoch(8, 2026);
	assert.equal(r.end - r.start, 31 * 86400, "August must span 31 GMT+8 days");
	assert.equal(platform.dateOfBucket(r.start), "2026-08-01");
	assert.equal(platform.dateOfBucket(r.start + 86400), "2026-08-02");
	assert.equal(platform.dateOfBucket(r.end), "2026-09-01");
	const dec = platform.monthRangeEpoch(12, 2026);
	assert.equal(platform.dateOfBucket(dec.start), "2026-12-01");
	assert.equal(platform.dateOfBucket(dec.end), "2027-01-01", "December must roll into the next year");
	// GMT+8 day start is exactly 8h behind UTC midnight.
	const utcMidnight = Math.floor(Date.UTC(2026, 7, 1) / 1000);
	assert.equal(utcMidnight - r.start, 28800);
	console.log("month-range epoch math ok");
}

async function testByKeyParsing() {
	const { amount, cost } = byKeyFixtures();
	const result = await platform.fetchPlatformUsageByKey("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("by_api_key/amount") ? okJson(amount) : okJson(cost))
	});
	assert.equal(result.source, "by-api-key");
	assert.equal(result.month, 8);
	assert.equal(result.year, 2026);
	assert.equal(result.currency, "CNY");

	// Days are GMT+8 and sorted; per-model day breakdown aggregated across keys.
	assert.equal(result.days.length, 2);
	assert.equal(result.days[0].date, "2026-08-01");
	assert.equal(result.days[0].totalTokens, 3400000 + 120000 + 96000);
	closeTo(result.days[0].totalCost, 0.35);
	assert.equal(result.days[0].totalRequests, 12, "day request totals must aggregate across api keys");
	assert.equal(result.days[0].keys.length, 1, "day entries must carry the per-key breakdown");
	assert.equal(result.days[0].keys[0].trackingId, "tid-1");
	assert.equal(result.days[0].keys[0].name, "Harness");
	assert.equal(result.days[0].keys[0].totalTokens, 3400000 + 120000 + 96000);
	assert.equal(result.days[0].keys[0].requestCount, 12);
	closeTo(result.days[0].models["deepseek-v4-flash"].cost, 0.35);
	closeTo(result.days[0].keys[0].cost, 0.35);
	assert.equal(result.days[1].date, "2026-08-02");
	assert.equal(result.days[1].totalTokens, 1808000 + 610000 + 130000);
	closeTo(result.days[1].totalCost, 3.90);
	assert.equal(result.days[1].totalRequests, 13);
	assert.equal(result.days[1].keys.length, 2, "per-key day rows must aggregate across models");
	const d2Keys = Object.fromEntries(result.days[1].keys.map((entry) => [entry.trackingId, entry]));
	assert.equal(d2Keys["tid-1"].totalTokens, 1808000 + 130000, "Harness must aggregate flash + composite");
	assert.equal(d2Keys["tid-1"].requestCount, 9);
	closeTo(d2Keys["tid-1"].cost, 1.40);
	assert.equal(d2Keys["tid-2"].totalTokens, 610000);
	assert.equal(d2Keys["tid-2"].requestCount, 4);
	closeTo(d2Keys["tid-2"].cost, 2.50);
	assert.equal(result.days[1].models["deepseek-v4-flash"].requestCount, 6);
	closeTo(result.days[1].models["deepseek-v4-flash"].cost, 0.60);
	closeTo(result.days[1].models["deepseek-v4-pro"].cost, 2.50);
	assert.equal(result.days[1].models["deepseek-chat & deepseek-reasoner"].requestCount, 3);
	closeTo(result.days[1].models["deepseek-chat & deepseek-reasoner"].cost, 0.80);
	assert.equal(result.days[1].models["deepseek-v4-flash"].cacheHitTokens, 1700000, "per-day model buckets must sum across api keys");

	// Per-model aggregates (across keys); all-zero series are dropped.
	assert.equal(result.models.length, 3);
	assert.equal(result.models.find((model) => model.key === "deepseek-v4-flash-vision-exp"), void 0, "all-zero model series must be excluded");
	const flash = result.models.find((model) => model.key === "deepseek-v4-flash");
	assert.equal(flash.name, "V4 Flash");
	assert.equal(flash.totalTokens, 3616000 + 1808000);
	assert.equal(flash.requestCount, 18);
	closeTo(flash.cost, 0.95);
	const chat = result.models.find((model) => model.key === "deepseek-chat & deepseek-reasoner");
	assert.equal(chat.name, "DeepSeek Chat & Reasoner", "composite model ids need a display name");
	closeTo(chat.cost, 0.80);

	// Per-API-Key aggregates.
	assert.equal(result.apiKeys.length, 2);
	const harness = result.apiKeys.find((entry) => entry.trackingId === "tid-1");
	assert.equal(harness.name, "Harness");
	assert.equal(harness.totalTokens, 5554000);
	assert.equal(harness.requestCount, 21);
	closeTo(harness.cost, 1.75);
	const codex = result.apiKeys.find((entry) => entry.trackingId === "tid-2");
	assert.equal(codex.totalTokens, 610000);
	closeTo(codex.cost, 2.50);
	closeTo(result.monthCost, 4.25);
	console.log("by_api_key parsing + aggregation + GMT+8 days ok");
}

async function testSmartFallback() {
	const { amount, cost } = byKeyFixtures();
	// Primary path: by_api_key only.
	const primary = await platform.fetchPlatformUsageSmart("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("by_api_key/amount") ? okJson(amount) : okJson(cost))
	});
	assert.equal(primary.source, "by-api-key");
	assert.equal(primary.apiKeys.length, 2);
	// Broken by_key shape → legacy fallback (source: legacy, no apiKeys).
	const legacy = await platform.fetchPlatformUsageSmart("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => {
			const u = String(url);
			if (u.includes("by_api_key")) return okJson(AMOUNT_FIXTURE); // wrong shape → fallback
			if (u.includes("/usage/amount")) return okJson(AMOUNT_FIXTURE);
			return okJson(COST_FIXTURE);
		}
	});
	assert.equal(legacy.source, "legacy");
	assert.equal(legacy.models.length, 2);
	assert.equal(legacy.apiKeys, void 0);
	closeTo(legacy.monthCost, 7.15);
	// Auth failure on by_api_key must NOT fall back.
	await assert.rejects(() => platform.fetchPlatformUsageSmart("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("by_api_key") ? errorJson(401) : okJson(COST_FIXTURE))
	}), (error) => error.providerStatus === "unauthorized");
	console.log("smart fetch primary + fallback + auth pass-through ok");
}

async function testPlatformCumulative() {
	// Month sum: by_api_key amount only, one fetch, all keys/models aggregated.
	const { amount } = byKeyFixtures();
	const calls = [];
	const sum = await platform.fetchPlatformMonthTokenSum("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => { calls.push(String(url)); return okJson(amount); }
	});
	assert.equal(sum, 3616000 + 1808000 + 610000 + 130000, "month sum must cover every key/model bucket");
	assert.equal(calls.length, 1, "month sum must be amount-only");
	assert.ok(calls[0].includes("by_api_key/amount") && !calls[0].includes("cost"), "month sum must use the by_api_key amount interface");

	// Cumulative walk: stops at the first empty month below the newest data month.
	const cumulative = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 8,
		year: 2026,
		maxMonths: 12,
		monthTotal: async (m, y) => {
			const totals = { "2026-08": 8001, "2026-07": 7001, "2026-06": 6001 };
			return totals[`${y}-${String(m).padStart(2, "0")}`] ?? 0;
		}
	});
	assert.equal(cumulative.total, 8001 + 7001 + 6001, "cumulative must sum every data month");
	assert.equal(cumulative.months, 3);
	assert.equal(cumulative.oldest, "2026-06");

	// A zero newest month must not terminate the walk; leading zeros are trimmed.
	const withGap = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 5,
		year: 2026,
		maxMonths: 12,
		monthTotal: async (m, y) => {
			const totals = { "2026-05": 0, "2026-04": 4001, "2026-03": 3001, "2026-02": 0 };
			return totals[`${y}-${String(m).padStart(2, "0")}`] ?? 0;
		}
	});
	assert.equal(withGap.total, 4001 + 3001, "an empty newest month must not suppress older data");
	assert.equal(withGap.months, 2);
	assert.equal(withGap.oldest, "2026-03");

	// No usage anywhere → empty cumulative.
	const empty = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 8,
		year: 2026,
		maxMonths: 4,
		monthTotal: async () => 0
	});
	assert.equal(empty.total, 0);
	assert.equal(empty.months, 0);
	assert.equal(empty.oldest, null);

	// Older-than-account months answer with a non-JSON body: the walk stops with a
	// partial result instead of failing the whole total, and complete=true when
	// every month that has usage was still scanned.
	const unavailable = () => {
		const error = new Error("platform API returned invalid JSON");
		error.providerStatus = "invalid-response";
		return error;
	};
	const tolerant = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 24,
		monthTotal: async (m, y) => {
			const key = `${y}-${String(m).padStart(2, "0")}`;
			const totals = { "2026-10": 10001, "2026-09": 9001, "2026-08": 8001 };
			if (totals[key] !== void 0) return totals[key];
			if (key === "2026-02") throw unavailable();
			return 0;
		}
	});
	assert.equal(tolerant.total, 10001 + 9001 + 8001, "a partial walk must still sum the readable months");
	assert.equal(tolerant.partial, true, "an unreadable old month must be reported as partial");
	assert.equal(tolerant.complete, true, "usage coverage is complete when the oldest usage month precedes the stop");
	assert.equal(tolerant.stoppedAt, "2026-02", "stoppedAt must name the first unreadable month");
	assert.equal(tolerant.oldest, "2026-08");
	assert.equal(tolerant.limited, false, "complete usage coverage must not be labelled limited");

	// A failure that is not "no history here" (auth, rate limit, params) still aborts.
	let authFailed = false;
	await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 12,
		monthTotal: async (m, y) => {
			const key = `${y}-${String(m).padStart(2, "0")}`;
			if (key === "2026-09") {
				const error = new Error("unauthorized");
				error.providerStatus = "unauthorized";
				throw error;
			}
			return 5;
		}
	}).catch((error) => {
		authFailed = error?.providerStatus === "unauthorized";
	});
	assert.equal(authFailed, true, "auth failures must still reject the scan");

	// Budget exhaustion marks the result limited (never presented as a lifetime total).
	const budgetCut = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 12,
		budgetMs: 1,
		monthTotal: async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return 1;
		}
	});
	assert.equal(budgetCut.limited, true, "a budget-cut scan must be flagged limited");
	assert.equal(budgetCut.partial, false, "a budget cut is not an unreadable-history stop");
	console.log("platform cumulative walk + month sum ok");
}

/** Single-day hourly fixture: 24 hourly amount+cost buckets (bucket=3600). */
function dayFixtures() {
	const date = "2026-08-23";
	const [y, m, d] = date.split("-").map(Number);
	const start = platform.dayStartEpoch(y, m, d);
	const meta = (trackingId, name) => ({ tracking_id: trackingId, name, sensitive_id: "sk-****", valid: true });
	const buckets = [];
	for (let h = 0; h < 24; h += 1) {
		buckets.push({ time: start + h * 3600, usage: { REQUEST: 0, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0, RESPONSE_TOKEN: 0 } });
	}
	buckets[8].usage = { REQUEST: 5, PROMPT_CACHE_HIT_TOKEN: 1000000, PROMPT_CACHE_MISS_TOKEN: 10000, RESPONSE_TOKEN: 2000 };
	buckets[20].usage = { REQUEST: 1, PROMPT_CACHE_HIT_TOKEN: 100, PROMPT_CACHE_MISS_TOKEN: 0, RESPONSE_TOKEN: 0 };
	return {
		amount: {
			data: {
				biz_data: {
					start,
					end: start + 86400,
					bucket: 3600,
					models: ["deepseek-v4-flash"],
					series: [{ api_key: meta("tid-1", "Harness"), model: "deepseek-v4-flash", buckets }]
				}
			}
		},
		cost: {
			data: {
				biz_data: {
					start,
					end: start + 86400,
					bucket: 3600,
					models: ["deepseek-v4-flash"],
					data: [{
						currency: "CNY",
						series: [{ api_key: { tracking_id: "tid-1" }, model: "deepseek-v4-flash", buckets: buckets.map((bucket, index) => ({ time: bucket.time, cost: index === 8 ? "0.35" : index === 20 ? "0.05" : "0" })) }]
					}]
				}
			}
		}
	};
}

async function testPlatformDayDetail() {
	const { amount, cost } = dayFixtures();
	const result = await platform.fetchPlatformDayDetail("token-t", {
		date: "2026-08-23",
		fetchImpl: async (url) => (String(url).includes("by_api_key/amount") ? okJson(amount) : okJson(cost))
	});
	assert.equal(result.source, "by-api-key");
	assert.equal(result.currency, "CNY");
	assert.equal(result.hours.length, 24, "a single-day query yields 24 hourly buckets");
	const hour8 = result.hours.find((h) => h.hour === 8);
	assert.equal(hour8.tokens, 1000000 + 10000 + 2000);
	assert.equal(hour8.requestCount, 5);
	closeTo(hour8.cost, 0.35);
	const hour20 = result.hours.find((h) => h.hour === 20);
	assert.equal(hour20.tokens, 100);
	assert.equal(hour20.requestCount, 1);
	closeTo(hour20.cost, 0.05);
	assert.equal(result.hours[0].tokens, 0, "empty hours must stay as zero buckets");
	assert.equal(result.perKey.length, 1);
	assert.equal(result.perKey[0].trackingId, "tid-1");
	assert.equal(result.perKey[0].name, "Harness");
	assert.equal(result.perKey[0].totalTokens, 1000000 + 10000 + 2000 + 100);
	assert.equal(result.perKey[0].requestCount, 6);
	closeTo(result.perKey[0].cost, 0.40);
	assert.equal(result.perModel.length, 1);
	assert.equal(result.perModel[0].model, "deepseek-v4-flash");
	assert.equal(result.perModel[0].totalTokens, 1000000 + 10000 + 2000 + 100);
	closeTo(result.perModel[0].cost, 0.40);
	await assert.rejects(() => platform.fetchPlatformDayDetail("token-t", { date: "2026-8-1", fetchImpl: async () => okJson(amount) }), (error) => error.providerStatus === "invalid-params");
	console.log("platform day detail (hourly buckets + per-key/per-model) ok");
}

//#region route tests (mirrors the fixtures of test-server.mjs)
async function freshModule(label, home) {
	process.env.DSH_HOME = home;
	return import(new URL(`../lib/index.js?platform-test=${label}-${Date.now()}-${Math.random()}`, import.meta.url));
}

function makeResponse() {
	return {
		status: null,
		body: "",
		writeHead(status) { this.status = status; },
		end(body = "") { this.body = body; }
	};
}

function makeContext({ token, routes, settings } = {}) {
	const credentials = { resolve: async (ref) => (token === void 0 ? void 0 : { value: token }) };
	return {
		logger: { warn: () => {} },
		credentials,
		webServer: { register: (entry) => { routes?.set(entry.path, entry.handler); return () => {}; } },
		effect: (register) => register(),
		get: (name) => name === "settings" ? settings : name === "credentials" ? credentials : void 0
	};
}

function request(url, remoteAddress = "127.0.0.1") {
	return { method: "GET", url, headers: { host: "localhost:3080" }, socket: { remoteAddress } };
}

async function testPlatformRoute(root) {
	const plugin = await freshModule("platform", join(root, "platform"));
	const routes = new Map();
	const context = makeContext({ token: "token-abc", routes, settings: { get: () => void 0 } });
	await plugin.apply(context, {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.PLATFORM_PATH);
	assert.equal(typeof handler, "function", "platform route must be registered");

	const foreign = makeResponse();
	await handler(request(plugin.PLATFORM_PATH, "203.0.113.7"), foreign);
	assert.equal(foreign.status, 403, "non-loopback callers must be refused");

	const head = makeResponse();
	await handler({ ...request(plugin.PLATFORM_PATH), method: "HEAD" }, head);
	assert.equal(head.status, 405, "the platform route is GET-only");

	const invalid = makeResponse();
	await handler(request(`${plugin.PLATFORM_PATH}?month=13&year=2026`), invalid);
	assert.equal(invalid.status, 400, "an invalid month must be rejected");
	assert.equal(JSON.parse(invalid.body).error, "invalid-params");

	// Success path with a stubbed upstream (collectPlatformUsage uses global fetch).
	const upstreamCalls = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = platformFetchStub(upstreamCalls);
	try {
		const ok = makeResponse();
		await handler(request(`${plugin.PLATFORM_PATH}?month=8&year=2026`), ok);
		assert.equal(ok.status, 200);
		const body = JSON.parse(ok.body);
		assert.equal(body.ok, true);
		assert.equal(body.source, "by-api-key");
		closeTo(body.monthCost, 4.25);
		assert.equal(body.models.length, 3);
		assert.equal(body.days.length, 2);
		assert.equal(body.apiKeys.length, 2);

		const cached = makeResponse();
		await handler(request(`${plugin.PLATFORM_PATH}?month=8&year=2026`), cached);
		assert.equal(JSON.parse(cached.body).ok, true);
		assert.equal(upstreamCalls.length, 2, "a second request within the TTL must hit the per-month cache");

		const forced = makeResponse();
		await handler(request(`${plugin.PLATFORM_PATH}?month=8&year=2026&refresh=1`), forced);
		assert.equal(JSON.parse(forced.body).ok, true);
		assert.equal(upstreamCalls.length, 4, "refresh=1 must bypass the cache");
	} finally {
		globalThis.fetch = previousFetch;
	}
	console.log("platform route (fence, params, no-credential, cache) ok");
}

async function testPlatformTotalRoute(root) {
	const plugin = await freshModule("total", join(root, "total"));
	const routes = new Map();
	await plugin.apply(makeContext({ token: "token-abc", routes, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.PLATFORM_TOTAL_PATH);
	assert.equal(typeof handler, "function", "platform total route must be registered");

	const foreign = makeResponse();
	await handler(request(plugin.PLATFORM_TOTAL_PATH, "203.0.113.7"), foreign);
	assert.equal(foreign.status, 403, "non-loopback callers must be refused");

	const put = makeResponse();
	await handler({ ...request(plugin.PLATFORM_TOTAL_PATH), method: "PUT" }, put);
	assert.equal(put.status, 405, "the total route is GET-only");

	// Success path: the stub answers one day per month (data for months 6–12),
	// so the walk terminates at the first empty month below the newest data.
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const u = String(url);
		if (!u.includes("by_api_key/amount")) throw new Error(`unexpected URL: ${u}`);
		const start = Number(new URL(u, "http://x").searchParams.get("start"));
		const month = Number(platform.dateOfBucket(start).slice(5, 7));
		const total = month >= 6 ? month * 1000 + 1 : 0;
		return {
			ok: true,
			status: 200,
			json: async () => ({
				data: {
					biz_data: {
						start,
						end: start + 86400,
						bucket: 86400,
						models: ["deepseek-v4-flash"],
						series: total > 0 ? [{
							api_key: { tracking_id: "t", name: "T", sensitive_id: "sk****", valid: true },
							model: "deepseek-v4-flash",
							buckets: [{ time: start, usage: { REQUEST: 1, PROMPT_CACHE_HIT_TOKEN: Math.floor(total / 2), PROMPT_CACHE_MISS_TOKEN: Math.floor(total / 3), RESPONSE_TOKEN: total - Math.floor(total / 2) - Math.floor(total / 3) } }]
						}] : []
					}
				}
			})
		};
	};
	let body;
	try {
		const ok = makeResponse();
		await handler(request(plugin.PLATFORM_TOTAL_PATH), ok);
		assert.equal(ok.status, 200);
		body = JSON.parse(ok.body);
		assert.equal(body.ok, true);
		assert.ok(typeof body.total === "number" && body.total > 0, "walk must find data months");
		assert.ok(body.months >= 1, "at least one data month within the walk window");
		assert.match(body.oldest ?? "", /^\d{4}-\d{2}$/);
	} finally {
		globalThis.fetch = previousFetch;
	}

	// A second request within the TTL must serve the cached summary.
	let fetchCount = 0;
	const previousFetch2 = globalThis.fetch;
	globalThis.fetch = async () => { fetchCount += 1; throw new Error("unexpected upstream"); };
	try {
		const cached = makeResponse();
		await handler(request(plugin.PLATFORM_TOTAL_PATH), cached);
		assert.equal(JSON.parse(cached.body).ok, true);
		assert.equal(fetchCount, 0, "the total summary must be cached in memory");
	} finally {
		globalThis.fetch = previousFetch2;
	}

	// Unconfigured token → no-credential state.
	const plugin2 = await freshModule("total-nokey", join(root, "total-nokey"));
	const routes2 = new Map();
	await plugin2.apply(makeContext({ routes: routes2, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const empty = makeResponse();
	await routes2.get(plugin2.PLATFORM_TOTAL_PATH)(request(plugin2.PLATFORM_TOTAL_PATH), empty);
	assert.equal(empty.status, 200);
	assert.equal(JSON.parse(empty.body).error, "no-credential");
	console.log("platform total route (fence, walk, cache, no-credential) ok");
}

async function testPlatformDayRoute(root) {
	const plugin = await freshModule("day", join(root, "day"));
	const routes = new Map();
	await plugin.apply(makeContext({ token: "token-abc", routes, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.PLATFORM_DAY_PATH);
	assert.equal(typeof handler, "function", "platform day route must be registered");

	const foreign = makeResponse();
	await handler(request(`${plugin.PLATFORM_DAY_PATH}?date=2026-08-23`, "203.0.113.7"), foreign);
	assert.equal(foreign.status, 403, "non-loopback callers must be refused");

	const missing = makeResponse();
	await handler(request(plugin.PLATFORM_DAY_PATH), missing);
	assert.equal(missing.status, 400, "a missing date must be rejected");
	assert.equal(JSON.parse(missing.body).error, "invalid-params");

	const fixtures = dayFixtures();
	let upstream = 0;
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		upstream += 1;
		return String(url).includes("by_api_key/amount") ? okJson(fixtures.amount) : okJson(fixtures.cost);
	};
	try {
		const ok = makeResponse();
		await handler(request(`${plugin.PLATFORM_DAY_PATH}?date=2026-08-23`), ok);
		assert.equal(ok.status, 200);
		const body = JSON.parse(ok.body);
		assert.equal(body.ok, true);
		assert.equal(body.hours.length, 24);
		assert.equal(body.perKey[0].name, "Harness");
		assert.equal(upstream, 2, "amount + cost must be fetched once");

		const cached = makeResponse();
		await handler(request(`${plugin.PLATFORM_DAY_PATH}?date=2026-08-23`), cached);
		assert.equal(JSON.parse(cached.body).ok, true);
		assert.equal(upstream, 2, "a second request within the TTL must hit the per-day cache");
	} finally {
		globalThis.fetch = previousFetch;
	}

	const plugin2 = await freshModule("day-nokey", join(root, "day-nokey"));
	const routes2 = new Map();
	await plugin2.apply(makeContext({ routes: routes2, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const empty = makeResponse();
	await routes2.get(plugin2.PLATFORM_DAY_PATH)(request(`${plugin2.PLATFORM_DAY_PATH}?date=2026-08-23`), empty);
	assert.equal(empty.status, 200);
	assert.equal(JSON.parse(empty.body).error, "no-credential");
	console.log("platform day route (fence, params, hourly, cache, no-credential) ok");
}

async function testPlatformNoCredential(root) {
	const plugin = await freshModule("platform-nokey", join(root, "platform-nokey"));
	const routes = new Map();
	await plugin.apply(makeContext({ routes, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const response = makeResponse();
	await routes.get(plugin.PLATFORM_PATH)(request(`${plugin.PLATFORM_PATH}?month=8&year=2026`), response);
	assert.equal(response.status, 200);
	const body = JSON.parse(response.body);
	assert.equal(body.ok, false);
	assert.equal(body.error, "no-credential");
	assert.equal(body.message, "DEEPSEEK_USAGE_TOKEN");
	console.log("platform no-credential state ok");
}

//#region usage-token settings route
import { EventEmitter } from "node:events";

function bodyRequest(url, method, body, headers = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost:3080", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers };
	req.socket = { remoteAddress: "127.0.0.1" };
	req.destroy = () => {};
	queueMicrotask(() => {
		req.emit("data", Buffer.from(body));
		req.emit("end");
	});
	return req;
}

async function testPlatformTokenRoute(root) {
	const plugin = await freshModule("token-settings", join(root, "token-settings"));
	const routes = new Map();
	await plugin.apply(makeContext({ routes, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.PLATFORM_TOKEN_PATH);
	assert.equal(typeof handler, "function", "token settings route must be registered");
	const tokenPath = plugin.PLATFORM_TOKEN_PATH;

	const foreign = makeResponse();
	// A foreign caller must be refused before the body is read.
	await handler({ ...bodyRequest(tokenPath, "POST", "{}"), socket: { remoteAddress: "203.0.113.7" } }, foreign);
	assert.equal(foreign.status, 403, "non-loopback token writes must be refused");

	const put = makeResponse();
	await handler(bodyRequest(tokenPath, "PUT", "{}"), put);
	assert.equal(put.status, 405, "PUT must be refused on the token route");

	// Initially unconfigured.
	const initial = makeResponse();
	await handler(request(tokenPath), initial);
	assert.equal(JSON.parse(initial.body).ok, true);
	assert.equal(JSON.parse(initial.body).configured, false);

	// Save → status flips to stored; the platform route starts using it.
	const save = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", JSON.stringify({ token: "saved-token-123" })), save);
	assert.equal(save.status, 200);
	assert.equal(JSON.parse(save.body).configured, true);

	const saved = makeResponse();
	await handler(request(tokenPath), saved);
	assert.equal(JSON.parse(saved.body).source, "stored");

	// Empty token is rejected.
	const empty = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", JSON.stringify({ token: "   " })), empty);
	assert.equal(empty.status, 400);

	// The platform route must use the stored token (credential seam empty) and
	// forward it as the Bearer credential upstream.
	const upstreamAuth = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = platformFetchStub([], upstreamAuth);
	try {
		const ok = makeResponse();
		await routes.get(plugin.PLATFORM_PATH)(request(`${plugin.PLATFORM_PATH}?month=8&year=2026`), ok);
		assert.equal(JSON.parse(ok.body).ok, true);
		assert.equal(upstreamAuth.length, 2, "amount and cost each carry the token");
		assert.ok(upstreamAuth.every((auth) => auth === "Bearer saved-token-123"), "stored token must be forwarded upstream");
	} finally {
		globalThis.fetch = previousFetch;
	}

	// Credential ref wins over the stored token when both exist.
	const routes2 = new Map();
	await plugin.apply(makeContext({ token: "cred-token-456", routes: routes2, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const status2 = makeResponse();
	await routes2.get(plugin.PLATFORM_TOKEN_PATH)(request(tokenPath), status2);
	assert.equal(JSON.parse(status2.body).source, "credential", "the configured credential ref must take precedence");

	// Clear → configured flips back to false.
	const cleared = makeResponse();
	await handler(bodyRequest(tokenPath, "DELETE", ""), cleared);
	assert.equal(JSON.parse(cleared.body).configured, false);
	const after = makeResponse();
	await handler(request(tokenPath), after);
	assert.equal(JSON.parse(after.body).configured, false);

	// The store is only one of two sources: with the credential ref in effect, a
	// clear/save must report what actually wins, never the intent.
	const clearWithCredential = makeResponse();
	await routes2.get(plugin.PLATFORM_TOKEN_PATH)(bodyRequest(tokenPath, "DELETE", ""), clearWithCredential);
	const clearedBody = JSON.parse(clearWithCredential.body);
	assert.equal(clearedBody.ok, true);
	assert.equal(clearedBody.configured, true, "the credential ref still powers the query");
	assert.equal(clearedBody.source, "credential", "the effective source must be the ref");
	assert.equal(clearedBody.storedConfigured, false, "nothing is left in the panel-owned store");
	assert.equal(clearedBody.credentialOverride, true);
	const afterClearStatus = makeResponse();
	await routes2.get(plugin.PLATFORM_TOKEN_PATH)(request(tokenPath), afterClearStatus);
	assert.equal(JSON.parse(afterClearStatus.body).configured, true, "GET must agree with the DELETE response");

	const saveUnderRef = makeResponse();
	await routes2.get(plugin.PLATFORM_TOKEN_PATH)(bodyRequest(tokenPath, "POST", JSON.stringify({ token: "other-token-789" })), saveUnderRef);
	const saveUnderRefBody = JSON.parse(saveUnderRef.body);
	assert.equal(saveUnderRefBody.ok, true);
	assert.equal(saveUnderRefBody.storedConfigured, true, "the POST did write the panel value");
	assert.equal(saveUnderRefBody.source, "credential", "but the effective source is still the ref");
	assert.equal(saveUnderRefBody.credentialOverride, true);
	console.log("platform token settings route (fence, save, precedence, clear) ok");
}

//#region web-login auto-sync route
function fakeLoginSync(overrides = {}) {
	let running = false;
	let last = null;
	const state = { starts: 0, cancels: 0 };
	return {
		state,
		start: async () => {
			state.starts += 1;
			running = true;
			if (overrides.failStart) {
				running = false;
				last = { ok: false, error: overrides.failStart, message: overrides.failMessage ?? "boom" };
				return { started: true, alreadyRunning: false };
			}
			return { started: true, alreadyRunning: false };
		},
		cancel: async () => { state.cancels += 1; running = false; return { ok: true, running: false }; },
		isRunning: async () => running,
		status: () => ({ running, last })
	};
}

async function testPlatformSyncRoute(root) {
	const plugin = await freshModule("sync-route", join(root, "sync-route"));
	const routes = new Map();
	const loginSync = fakeLoginSync();
	await plugin.apply(makeContext({ routes, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true, loginSync });
	const handler = routes.get(plugin.PLATFORM_SYNC_PATH);
	assert.equal(typeof handler, "function", "sync route must be registered");
	const syncPath = plugin.PLATFORM_SYNC_PATH;

	const foreign = makeResponse();
	await handler({ ...bodyRequest(syncPath, "POST", "{}"), socket: { remoteAddress: "203.0.113.7" } }, foreign);
	assert.equal(foreign.status, 403, "non-loopback sync starts must be refused");

	const put = makeResponse();
	await handler(bodyRequest(syncPath, "PUT", "{}"), put);
	assert.equal(put.status, 405, "PUT must be refused on the sync route");

	const initial = makeResponse();
	await handler(request(syncPath), initial);
	assert.deepEqual(JSON.parse(initial.body), { ok: true, running: false, last: null });

	const started = makeResponse();
	await handler(bodyRequest(syncPath, "POST", "{}"), started);
	assert.equal(JSON.parse(started.body).ok, true);
	assert.equal(loginSync.state.starts, 1);

	const running = makeResponse();
	await handler(request(syncPath), running);
	assert.equal(JSON.parse(running.body).running, true);

	const stopped = makeResponse();
	await handler(bodyRequest(syncPath, "DELETE", ""), stopped);
	assert.equal(loginSync.state.cancels, 1);

	// A failure to start (e.g. no browser) is surfaced through status().last.
	const broken = fakeLoginSync({ failStart: "sync-unavailable", failMessage: "Edge/Chrome not found" });
	const routes2 = new Map();
	await plugin.apply(makeContext({ routes: routes2, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true, loginSync: broken });
	const failed = makeResponse();
	await routes2.get(plugin.PLATFORM_SYNC_PATH)(bodyRequest(syncPath, "POST", "{}"), failed);
	assert.equal(JSON.parse(failed.body).ok, true, "start is async; failures surface via status");
	const failedStatus = makeResponse();
	await routes2.get(plugin.PLATFORM_SYNC_PATH)(request(syncPath), failedStatus);
	const failedBody = JSON.parse(failedStatus.body);
	assert.equal(failedBody.last.error, "sync-unavailable");
	console.log("platform sync route (fence, start, status, cancel, failure) ok");
}
//#endregion

/**
 * Report repro 1: an empty month only says that month had no usage — it never
 * proves earlier months had none. Oct 100 / Sep 0 / Aug 300 must total 400, and
 * because the walk is window-bounded the result must carry a range + `limited`
 * flag instead of pretending to be a lifetime total.
 */
async function testPlatformCumulativeGap() {
	const totals = { "2026-10": 100, "2026-09": 0, "2026-08": 300 };
	const walk = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 6,
		monthTotal: async (m, y) => totals[`${y}-${String(m).padStart(2, "0")}`] ?? 0
	});
	assert.equal(walk.total, 400, "an empty month must not hide older usage");
	assert.equal(walk.months, 2);
	assert.equal(walk.oldest, "2026-08");
	assert.equal(walk.newest, "2026-10");
	assert.equal(walk.scannedMonths, 6, "the whole window must be scanned");
	assert.deepEqual(walk.range, { from: "2026-05", to: "2026-10" });
	// A fully scanned window says nothing about months before it: 2026-04 and older
	// were never queried, so the sum is a scanned-range total, not a lifetime one.
	assert.equal(walk.limited, true, "a fully scanned window cannot claim a lifetime total");
	assert.equal(walk.limitedReason, "window");
	assert.equal(walk.complete, false, "no verifiable end was reached, so coverage is not complete");

	// Transient upstream failure mid-walk: the scan keeps what it read, but a 5xx is
	// NOT evidence that history ended — limited + partial + incomplete.
	const transient = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 24,
		monthTotal: async (m, y) => {
			const key = `${y}-${String(m).padStart(2, "0")}`;
			if (key === "2026-08") {
				const error = new Error("upstream 503");
				error.providerStatus = "unavailable";
				throw error;
			}
			return key === "2026-10" ? 100 : 0;
		}
	});
	assert.equal(transient.total, 100, "readable months must still be summed");
	assert.equal(transient.partial, true, "a stopped walk is partial");
	assert.equal(transient.complete, false, "a 503 must never be reported as a complete history");
	assert.equal(transient.limited, true, "a 503 stop may hide older usage");
	assert.equal(transient.limitedReason, "upstream");
	assert.equal(transient.stoppedAt, "2026-08");

	// Usage all the way down to the window edge: there may be more history.
	const full = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 3,
		monthTotal: async () => 10
	});
	assert.equal(full.total, 30);
	assert.equal(full.limited, true, "usage reaching the window edge must be flagged limited");
	assert.equal(full.scannedMonths, 3);
	assert.deepEqual(full.range, { from: "2026-08", to: "2026-10" });

	// No usage anywhere in the window — "0" must not be sold as a lifetime total.
	const none = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 4,
		monthTotal: async () => 0
	});
	assert.equal(none.total, 0);
	assert.equal(none.oldest, null);
	assert.equal(none.limited, true, "an empty window cannot claim a lifetime zero");

	// Scan budget: a slow upstream stops the walk instead of stalling the route.
	const budget = await platform.fetchPlatformCumulativeTokenTotal("token-t", {
		month: 10,
		year: 2026,
		maxMonths: 24,
		budgetMs: 1,
		monthTotal: async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return 7;
		}
	});
	assert.equal(budget.scannedMonths, 1, "the scan budget must stop the walk");
	assert.equal(budget.total, 7);
	assert.equal(budget.limited, true);
	console.log("platform cumulative gap + window flags ok");
}

/**
 * Report repro 6: HTTP 200 with a missing cost payload is "cost unavailable",
 * never a confirmed zero. All three parsing paths must say so.
 */
async function testPlatformCostAvailability() {
	const { amount, cost } = byKeyFixtures();
	const costless = { data: { biz_data: null } };

	const month = await platform.fetchPlatformUsageByKey("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("by_api_key/amount") ? okJson(amount) : okJson(costless))
	});
	assert.equal(month.costAvailable, false, "a missing by_api_key cost payload must not look like zero cost");
	assert.equal(month.monthCost, 0);
	assert.ok(month.days.length > 0, "token figures must survive a missing cost payload");

	const priced = await platform.fetchPlatformUsageByKey("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("by_api_key/amount") ? okJson(amount) : okJson(cost))
	});
	assert.equal(priced.costAvailable, true);
	closeTo(priced.monthCost, 4.25);

	const dayFix = dayFixtures();
	const day = await platform.fetchPlatformDayDetail("token-t", {
		date: "2026-08-23",
		fetchImpl: async (url) => (String(url).includes("by_api_key/amount") ? okJson(dayFix.amount) : okJson(costless))
	});
	assert.equal(day.costAvailable, false, "the day detail must flag a missing cost payload too");

	const legacy = await platform.fetchPlatformUsage("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("/usage/amount") ? okJson(AMOUNT_FIXTURE) : okJson(costless))
	});
	assert.equal(legacy.costAvailable, false, "the legacy fallback must flag a missing cost payload too");
	assert.equal(legacy.monthCost, 0);

	const legacyPriced = await platform.fetchPlatformUsage("token-t", {
		month: 8,
		year: 2026,
		fetchImpl: async (url) => (String(url).includes("/usage/amount") ? okJson(AMOUNT_FIXTURE) : okJson(COST_FIXTURE))
	});
	assert.equal(legacyPriced.costAvailable, true);
	closeTo(legacyPriced.monthCost, 7.15);
	console.log("platform cost availability ok (by_api_key / day / legacy)");
}

/** A context whose credential seam resolves exactly the refs it is given, recording lookups. */
function refContext({ refs, routes, resolvedRefs }) {
	const credentials = {
		resolve: async (ref) => {
			resolvedRefs.push(ref);
			return refs[ref] === void 0 ? void 0 : { value: refs[ref] };
		}
	};
	return {
		logger: { warn: () => {} },
		credentials,
		webServer: { register: (entry) => { routes?.set(entry.path, entry.handler); return () => {}; } },
		effect: (register) => register(),
		get: (name) => name === "settings" ? { get: () => void 0 } : name === "credentials" ? credentials : void 0
	};
}

/**
 * Report repro 2: `usageTokenRef` was honoured by the settings page (and the
 * background refresh) but not by the month/total/day routes, so a custom ref
 * reported "configured" while every query answered "no-credential".
 */
async function testPlatformCredentialRefRouting(root) {
	const refs = { CUSTOM_USAGE: "custom-token-abc" };
	const routes = new Map();
	const resolvedRefs = [];
	const plugin = await freshModule("custom-ref", join(root, "custom-ref"));
	await plugin.apply(refContext({ refs, routes, resolvedRefs }), { usageTokenRef: "CUSTOM_USAGE" }, { disableBackgroundRefresh: true });

	const status = makeResponse();
	await routes.get(plugin.PLATFORM_TOKEN_PATH)(request(plugin.PLATFORM_TOKEN_PATH), status);
	assert.equal(JSON.parse(status.body).configured, true, "the settings route must see the custom ref");

	const previousFetch = globalThis.fetch;
	globalThis.fetch = platformFetchStub([]);
	try {
		for (const path of [plugin.PLATFORM_PATH, plugin.PLATFORM_TOTAL_PATH]) {
			const response = makeResponse();
			await routes.get(path)(request(path), response);
			const body = JSON.parse(response.body);
			assert.equal(body.ok, true, `${path} must use the configured credential ref (got ${body.error ?? "ok"})`);
		}
		const day = makeResponse();
		await routes.get(plugin.PLATFORM_DAY_PATH)(request(`${plugin.PLATFORM_DAY_PATH}?date=2026-08-23`), day);
		assert.equal(JSON.parse(day.body).ok, true, "the day route must use the configured credential ref");
	} finally {
		globalThis.fetch = previousFetch;
	}
	const monthRefs = [...new Set(resolvedRefs)];
	assert.ok(monthRefs.every((ref) => ref === "CUSTOM_USAGE"), `every platform route must resolve the configured ref, saw ${JSON.stringify(monthRefs)}`);

	// The default ref stays the default: a credential stored under another name
	// must NOT satisfy an unconfigured plugin.
	const routes2 = new Map();
	const defaultRefs = [];
	const plugin2 = await freshModule("default-ref", join(root, "default-ref"));
	await plugin2.apply(refContext({ refs, routes: routes2, resolvedRefs: defaultRefs }), {}, { disableBackgroundRefresh: true });
	for (const path of [plugin2.PLATFORM_PATH, plugin2.PLATFORM_TOTAL_PATH]) {
		const response = makeResponse();
		await routes2.get(path)(request(path), response);
		assert.equal(JSON.parse(response.body).error, "no-credential", `${path} must not read a differently-named credential`);
	}
	assert.ok(defaultRefs.includes("DEEPSEEK_USAGE_TOKEN"), "the default ref must still be resolved by name");
	console.log("platform credential ref routing ok (custom ref wired into month/total/day)");
}

/**
 * Report repro 3: the platform caches were keyed by month/date only, so switching
 * the credential kept serving the previous account's numbers, and a forced
 * cumulative refresh still reused the five-minute per-month sub-cache.
 */
async function testPlatformCacheIdentity(root) {
	const refs = { DEEPSEEK_USAGE_TOKEN: "token-a" };
	const routes = new Map();
	const plugin = await freshModule("cache-identity", join(root, "cache-identity"));
	await plugin.apply(refContext({ refs, routes, resolvedRefs: [] }), {}, { disableBackgroundRefresh: true });

	const previousFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const u = String(url);
		const f = byKeyFixtures();
		if (u.includes("by_api_key/amount")) return okJson(f.amount);
		if (u.includes("by_api_key/cost")) return okJson(f.cost);
		if (u.includes("/usage/amount")) return okJson(AMOUNT_FIXTURE);
		if (u.includes("/usage/cost")) return okJson(COST_FIXTURE);
		throw new Error(`unexpected URL in stub: ${u}`);
	};
	try {
		const monthPath = `${plugin.PLATFORM_PATH}?month=8&year=2026`;
		const dayPath = `${plugin.PLATFORM_DAY_PATH}?date=2026-08-23`;
		const firstMonth = makeResponse();
		await routes.get(plugin.PLATFORM_PATH)(request(monthPath), firstMonth);
		closeTo(JSON.parse(firstMonth.body).monthCost, 4.25);

		// Same credential, second read → served from the in-memory cache.
		const callsAfterFirst = calls.length;
		const cached = makeResponse();
		await routes.get(plugin.PLATFORM_PATH)(request(monthPath), cached);
		assert.equal(calls.length, callsAfterFirst, "a repeat read inside the TTL must not re-query upstream");

		// Credential switch → the cached month/day/total must not survive.
		refs.DEEPSEEK_USAGE_TOKEN = "token-b";
		const switchedMonth = makeResponse();
		await routes.get(plugin.PLATFORM_PATH)(request(monthPath), switchedMonth);
		assert.ok(calls.length > callsAfterFirst, "switching the credential must re-query upstream");
		assert.equal(JSON.parse(switchedMonth.body).ok, true);

		const switchedDay = makeResponse();
		await routes.get(plugin.PLATFORM_DAY_PATH)(request(dayPath), switchedDay);
		assert.equal(JSON.parse(switchedDay.body).ok, true);
		const dayCalls = calls.length;
		const cachedDay = makeResponse();
		await routes.get(plugin.PLATFORM_DAY_PATH)(request(dayPath), cachedDay);
		assert.equal(calls.length, dayCalls, "the day cache is reused for the new credential");
		refs.DEEPSEEK_USAGE_TOKEN = "token-c";
		const switchedDayAgain = makeResponse();
		await routes.get(plugin.PLATFORM_DAY_PATH)(request(dayPath), switchedDayAgain);
		assert.ok(calls.length > dayCalls, "switching the credential must invalidate the day cache too");

		// Forced cumulative refresh must bypass the per-month sub-cache.
		const totalPath = plugin.PLATFORM_TOTAL_PATH;
		const first = makeResponse();
		await routes.get(totalPath)(request(totalPath), first);
		assert.equal(JSON.parse(first.body).ok, true);
		const beforeForce = calls.length;
		const forced = makeResponse();
		await routes.get(totalPath)(request(`${totalPath}?refresh=1`), forced);
		assert.equal(JSON.parse(forced.body).ok, true);
		assert.ok(calls.length - beforeForce >= 1, "refresh=1 must re-query the monthly sums instead of reusing the sub-cache");
	} finally {
		globalThis.fetch = previousFetch;
	}
	console.log("platform cache identity ok (credential switch + force-through-subcache)");
}

/**
 * Report repro 9: the token route accepted any loopback request. A cross-site
 * page in the user's own browser also arrives from 127.0.0.1, so the write must
 * additionally check Origin / Sec-Fetch-Site / JSON content type. Requests
 * without an Origin stay allowed for local tools.
 */
async function testRouteSameOriginFence(root) {
	const plugin = await freshModule("same-origin", join(root, "same-origin"));
	const routes = new Map();
	await plugin.apply(makeContext({ routes, settings: { get: () => void 0 } }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.PLATFORM_TOKEN_PATH);
	const tokenPath = plugin.PLATFORM_TOKEN_PATH;
	const body = JSON.stringify({ token: "saved-token-123" });

	const foreignOrigin = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", body, { origin: "https://evil.example" }), foreignOrigin);
	assert.equal(foreignOrigin.status, 403, "a foreign Origin must be refused");

	const crossSite = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", body, { "sec-fetch-site": "cross-site" }), crossSite);
	assert.equal(crossSite.status, 403, "Sec-Fetch-Site: cross-site must be refused");

	const plainText = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", body, { "content-type": "text/plain" }), plainText);
	assert.equal(plainText.status, 415, "a non-JSON body must be refused");

	const sameOrigin = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", body, { origin: "http://localhost:3080" }), sameOrigin);
	assert.equal(sameOrigin.status, 200, "the panel's own same-origin POST must pass");

	const noOrigin = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", JSON.stringify({ token: "cli-token-456" })), noOrigin);
	assert.equal(noOrigin.status, 200, "a local tool without an Origin header must still work");

	const otherLoopbackPort = makeResponse();
	await handler(bodyRequest(tokenPath, "POST", body, { origin: "http://127.0.0.1:9999" }), otherLoopbackPort);
	assert.equal(otherLoopbackPort.status, 403, "a different loopback origin must not write credentials");
	console.log("platform token route same-origin fence ok (origin / sec-fetch-site / content-type)");
}

const root = await mkdtemp(join(tmpdir(), "dsh-usage-stats-platform-"));
try {
	await testParseAndBreakdown();
	await testFetchNormalization();
	await testErrorMapping();
	await testMonthRangeEpoch();
	await testByKeyParsing();
	await testSmartFallback();
	await testPlatformCumulative();
	await testPlatformCumulativeGap();
	await testPlatformCostAvailability();
	await testPlatformDayDetail();
	await testPlatformRoute(root);
	await testPlatformTotalRoute(root);
	await testPlatformDayRoute(root);
	await testPlatformNoCredential(root);
	await testPlatformTokenRoute(root);
	await testPlatformSyncRoute(root);
	await testPlatformCredentialRefRouting(root);
	await testPlatformCacheIdentity(root);
	await testRouteSameOriginFence(root);
	console.log("PLATFORM REGRESSION TESTS PASSED");
} finally {
	delete process.env.DSH_HOME;
	await rm(root, { recursive: true, force: true });
}
