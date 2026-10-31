/**
 * dsh-usage-stats — server half.
 *
 * Registers the loopback-only endpoints on the web server:
 *   GET /api/usage-stats/usage          — per-day token usage across every session
 *   GET /api/usage-stats/session        — one session's estimated cost (?sessionId=)
 *       (the session plus every subagent descendant, peak/off-peak priced)
 *   GET /api/usage-stats/account        — DeepSeek balance snapshot (?refresh=1)
 *   GET /api/usage-stats/platform       — DeepSeek platform usage (?month=&year=&refresh=)
 *   GET /api/usage-stats/platform/total — all-time platform token total (?refresh=1)
 *   GET /api/usage-stats/platform/day   — one day's hourly + per-API-Key detail (?date=)
 *   GET|POST|DELETE /api/usage-stats/platform/token — usage-token settings
 *       (status / save / clear; the token itself never leaves the server)
 *   GET|POST|DELETE /api/usage-stats/platform/sync — web-login auto-sync
 *       (start / status / cancel; opens a system browser window on demand)
 *
 * This plugin is DeepSeek-only. The balance connection facts come from the
 * harness `llm-deepseek` settings namespace (falling back to DEEPSEEK_API_KEY
 * and https://api.deepseek.com), and the API key is resolved through the
 * credentials seam at request time — nothing is stored by this plugin.
 *
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence (the exact routes bypass the RPC trust
 * fence); Host is checked only as an additional defense.
 *
 * Usage aggregation is INCREMENTAL: per-session fold state (day/model
 * buckets plus the last usage sample) is cached in memory and persisted to
 * `<DSH_HOME>/storages/usage-stats-cache.json`. On each request only the
 * events added since the last fold are processed — live sessions fold their
 * in-memory tail, while persisted sessions use the storage backend's opaque
 * revision when available. Steady-state cost stays O(new events) no matter
 * how large the logs grow. The rendered snapshot is additionally reused for
 * one polling window (see `readUsageSnapshot`), so a burst of callers cannot
 * stack folds.
 *
 * @module dsh-usage-stats
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { applyUsageDelta, createUsageState, mergeInto, renderUsage, totalTokens, zeroBuckets } from "./usage.js";
import { applyCostDelta, createCostState, renderCost } from "./cost.js";
import { describePricePeriod } from "./price-period.js";
import { holidayCalendarInfo, loadHolidayCache, refreshHolidayCalendar } from "./holidays.js";
import { ACCOUNT_REFRESH_MS, createAccountService, validateAccountConfig } from "./accounts.js";
import { DEEPSEEK_USAGE_TOKEN_REF, fetchPlatformCumulativeTokenTotal, fetchPlatformDayDetail, fetchPlatformMonthTokenSum, fetchPlatformUsageSmart, normalizeMonthYear, verifyUsageToken } from "./platform.js";
import { createLoginSync } from "./sync.js";

/** Stable Cordis plugin name. */
const name = "usage-stats";

/**
 * 插件版本号：直接从 package.json 读，避免前端再抄一份。读不到就留空，
 * 客户端据此只是不显示版本行，不影响其它功能。
 */
const PLUGIN_VERSION = (() => {
	try {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return typeof manifest.version === "string" ? manifest.version : "";
	} catch {
		return "";
	}
})();

/** Services required before this plugin activates. */
const inject = ["webServer", "credentials", "sessions", "sessionPersistence", "settings"];

const USAGE_PATH = "/api/usage-stats/usage";
const SESSION_COST_PATH = "/api/usage-stats/session";
const ACCOUNT_PATH = "/api/usage-stats/account";
const PLATFORM_PATH = "/api/usage-stats/platform";
const PRICE_PERIOD_PATH = "/api/usage-stats/price-period";
const UPSTREAM_TIMEOUT_MS = 15000;
const PLATFORM_REFRESH_MS = 300000;
/** A finished month never changes, so the cumulative walk may reuse history far
 * longer than the month in progress; the scan revisits up to 24 of them. */
const PLATFORM_HISTORY_REFRESH_MS = 1800000;
/** Upper bound for one cumulative scan, so the ↻ button can never hang on 24
 * slow upstream calls (the partial result is returned flagged `limited`). */
const PLATFORM_TOTAL_BUDGET_MS = 15000;
/** A scan that stopped early (older months unreadable) is retried sooner, so a
 * transient upstream failure cannot pin a partial total for the full refresh. */
const PLATFORM_TOTAL_PARTIAL_REFRESH_MS = 60000;
const CACHE_VERSION = 4;

/** Default DeepSeek connection facts when the settings namespace is absent. */
const DEEPSEEK_DEFAULTS = {
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseURL: "https://api.deepseek.com"
};

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const name = hostNameOf(req.headers.host);
	return name === "localhost" || isLoopbackAddress(name);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (isLoopbackAddress(peer) && isLoopbackHostHeader(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

//#region incremental cache
/** Cache file location under the dsh home. */
function cachePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "usage-stats-cache.json");
}

let loadedCache = null;
let loadPromise = null;
let inflight = null;

/** Serialize one session's fold state (Maps → plain objects). */
function serializeSession(state) {
	const days = {};
	for (const [date, entry] of state.days) {
		const models = {};
		for (const [model, buckets] of entry.models) models[model] = { ...buckets };
		days[date] = { totals: { ...entry.totals }, models };
	}
	return {
		kind: state.kind ?? "persisted",
		consumed: state.consumed ?? 0,
		...(state.revision === void 0 ? {} : { revision: state.revision }),
		days,
		lastSample: state.lastSample === null ? null : {
			key: state.lastSample.key,
			day: state.lastSample.day,
			model: state.lastSample.model,
			buckets: { ...state.lastSample.buckets }
		},
		currentModel: state.currentModel
	};
}

/** Parse a serialized session entry back into fold state (lenient). */
function parseSession(raw) {
	const state = createUsageState();
	if (raw === null || typeof raw !== "object") return state;
	state.kind = typeof raw.kind === "string" ? raw.kind : "persisted";
	state.consumed = Number.isSafeInteger(raw.consumed) ? raw.consumed : 0;
	if (typeof raw.revision === "string") state.revision = raw.revision;
	if (raw.days !== null && typeof raw.days === "object") {
		for (const [date, entry] of Object.entries(raw.days)) {
			if (entry === null || typeof entry !== "object") continue;
			const target = { totals: zeroBuckets(), models: new Map() };
			const totals = entry.totals;
			if (totals !== null && typeof totals === "object") {
				target.totals.inputTokens = Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0;
				target.totals.outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0;
				target.totals.cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0;
				target.totals.cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0;
			}
			if (entry.models !== null && typeof entry.models === "object") {
				for (const [model, buckets] of Object.entries(entry.models)) {
					if (buckets === null || typeof buckets !== "object") continue;
					target.models.set(model, {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					});
				}
			}
			state.days.set(date, target);
		}
	}
	if (raw.lastSample !== null && raw.lastSample !== void 0 && typeof raw.lastSample === "object" && typeof raw.lastSample.key === "string" && typeof raw.lastSample.day === "string") {
		const buckets = raw.lastSample.buckets ?? {};
		state.lastSample = {
			key: raw.lastSample.key,
			day: raw.lastSample.day,
			model: typeof raw.lastSample.model === "string" ? raw.lastSample.model : "unknown",
			buckets: {
				inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
				outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
				cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
				cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
			}
		};
	}
	if (typeof raw.currentModel === "string") state.currentModel = raw.currentModel;
	return state;
}

/** Load the cache once per process; any corruption degrades to a fresh cache. */
async function loadCache() {
	if (loadedCache !== null) return loadedCache;
	loadPromise ??= (async () => {
		const fresh = { version: CACHE_VERSION, sessions: {} };
		try {
			const raw = await readFile(cachePath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && parsed.version === CACHE_VERSION && parsed.sessions !== null && typeof parsed.sessions === "object") {
				const sessions = {};
				for (const [id, entry] of Object.entries(parsed.sessions)) {
					if (typeof id === "string" && id.length > 0) sessions[id] = parseSession(entry);
				}
				return { version: CACHE_VERSION, sessions };
			}
		} catch {
			/* first run or corrupt cache */
		}
		return fresh;
	})();
	loadedCache = await loadPromise;
	return loadedCache;
}

/** Persist the cache atomically (temp + rename); failures are logged, never fatal. */
async function saveCache(ctx, cache) {
	try {
		const path = cachePath();
		await mkdir(dirname(path), { recursive: true });
		const serialized = { version: CACHE_VERSION, sessions: {} };
		for (const [id, state] of Object.entries(cache.sessions)) serialized.sessions[id] = serializeSession(state);
		const tmp = `${path}.tmp`;
		await writeFile(tmp, JSON.stringify(serialized), "utf8");
		await rename(tmp, path);
	} catch (error) {
		ctx.logger.warn(`usage-stats: saving usage cache failed: ${String(error)}`);
	}
}

/** Single-flight guard: concurrent requests share one aggregation run. */
function withLock(run) {
	if (inflight !== null) return inflight;
	inflight = run().finally(() => {
		inflight = null;
	});
	return inflight;
}
//#endregion

/**
 * Collect per-day usage across live and persisted sessions, incrementally.
 *
 * Live sessions: fold only the in-memory events added since the last fold.
 * Persisted sessions: skipped when the backend's opaque revision is
 * unchanged (`sessionPersistence.list()` on dsh 0.1.2, `listSnapshots()` on
 * older harnesses); when the revision changes, the new events are read
 * through `open(id, "read")` + `handle.read(fromSeq)` (or the legacy
 * `readFrom`) and verified to be contiguous with the last folded seq — a gap
 * or an empty delta means the log was truncated/rewritten, so the session is
 * refolded from scratch. Sessions that vanished are dropped, and a session
 * switching between live/persisted is refolded from scratch to stay exact.
 */
/**
 * Read a live session's event log across harness versions. Current dsh
 * exposes `snapshotEvents(fromSeq, toSeqExclusive)` with `seq` as the log
 * length (the `from = 0, to = seq` form returns a cached frozen array);
 * older harnesses exposed an `events` array getter. Returns null when the
 * session exposes neither, so the caller skips that session instead of
 * failing the whole aggregation.
 */
function liveSessionEvents(session) {
	if (session !== null && session !== void 0 && typeof session.snapshotEvents === "function") {
		const end = typeof session.seq === "number" ? session.seq : void 0;
		return end === void 0 ? session.snapshotEvents() : session.snapshotEvents(0, end);
	}
	if (Array.isArray(session?.events)) return session.events;
	return null;
}

/**
 * Read a stored session's event log across harness versions. dsh 0.1.2
 * removed `persistence.readFrom(id, fromSeq)` in favour of
 * `open(id, "read")` + `handle.read(offset)`, and `list()` now returns
 * snapshots (`{ header, revision, … }`) instead of bare headers. Older
 * harnesses exposed `readFrom` directly. Both shapes are supported so the
 * persisted half of the aggregation never silently degrades to "no history".
 * @param persistence - the sessionPersistence service.
 * @param id - stored session id.
 * @param fromSeq - first logical event seq to include.
 * @returns the event slice (possibly empty).
 */
async function readPersistedEvents(persistence, id, fromSeq) {
	if (typeof persistence.readFrom === "function") {
		const { events } = await persistence.readFrom(id, fromSeq);
		return events;
	}
	if (typeof persistence.open === "function") {
		const handle = await persistence.open(id, "read");
		try {
			const { events } = await handle.read(fromSeq);
			return events;
		} finally {
			await handle.close();
		}
	}
	throw new Error("persistence backend exposes neither readFrom() nor open()");
}

/**
 * Normalize the persistence listing across harness versions to
 * `{ ok, snapshots }` with snapshots shaped `[{ header, revision }]`. dsh 0.1.2's
 * `list()` returns snapshots; the older `listSnapshots()` returned the same shape.
 *
 * `ok: false` is the important part: a failed listing must never be mistaken for
 * "this account has no sessions". The caller prunes cached sessions missing from
 * the listing, so treating a transient storage error as an empty list deleted
 * every cached fold and reported a total of 0 as if it were real.
 */
async function listPersistedSnapshots(ctx, persistence) {
	if (typeof persistence.listSnapshots === "function") {
		try {
			const listed = await persistence.listSnapshots();
			return { ok: true, snapshots: Array.isArray(listed) ? listed : [] };
		} catch (error) {
			ctx.logger.warn(`usage-stats: listSnapshots failed, falling back to list(): ${String(error)}`);
		}
	}
	if (typeof persistence.list === "function") {
		try {
			const listed = await persistence.list();
			return { ok: true, snapshots: Array.isArray(listed) ? listed : [] };
		} catch (error) {
			ctx.logger.warn(`usage-stats: persistence list() failed; keeping the cached persisted usage: ${String(error)}`);
			return { ok: false, snapshots: [] };
		}
	}
	ctx.logger.warn("usage-stats: persistence backend exposes neither listSnapshots() nor list(); persisted usage skipped");
	return { ok: false, snapshots: [] };
}

export async function collectUsage(ctx) {
	return withLock(async () => {
		const cache = await loadCache();
		const live = ctx.get("sessions");
		const attached = new Set();
		if (live !== void 0) {
			for (const session of live.list()) {
				try {
					attached.add(session.id);
					const state = cache.sessions[session.id] ?? createUsageState();
					if (state.kind !== "live") {
						// Live/persisted transition: refold the whole in-memory log.
						state.days = new Map();
						state.lastSample = null;
						state.currentModel = null;
						state.consumed = 0;
					}
					const events = liveSessionEvents(session);
					if (events !== null) {
						const count = events.length;
						if ((state.consumed ?? 0) < count) {
							applyUsageDelta(state, events.slice(state.consumed ?? 0));
							state.consumed = count;
						}
					}
					state.kind = "live";
					cache.sessions[session.id] = state;
				} catch (error) {
					// One unreadable session must not fail the whole route.
					ctx.logger.warn(`usage-stats: folding live session "${session?.id ?? "unknown"}" failed: ${String(error)}`);
				}
			}
		}
		const persistence = ctx.get("sessionPersistence");
		const persistedIds = new Set();
		// A missing service, a backend that cannot list, and a failed listing all
		// mean the same thing: the sessions could not be enumerated. Keep every
		// cached fold and flag the payload instead of pruning history away on the
		// strength of information we do not have.
		let listingOk = false;
		if (persistence !== void 0) {
			// Prefer the backend's opaque per-log revisions (no file I/O in the
			// plugin). dsh 0.1.2 exposes `list()` (snapshots) and dropped both
			// `listSnapshots()` and `readFrom()`; both generations are supported.
			const listing = await listPersistedSnapshots(ctx, persistence);
			listingOk = listing.ok;
			const snapshots = listing.snapshots;
			const metas = snapshots.map((entry) => entry?.header).filter((header) => header !== void 0 && header !== null);
			const revisionOf = new Map();
			for (const entry of snapshots) {
				if (entry?.header?.id !== void 0 && entry.revision !== void 0) revisionOf.set(entry.header.id, entry.revision);
			}
			for (const meta of metas) {
				persistedIds.add(meta.id);
				if (attached.has(meta.id)) continue;
				const state = cache.sessions[meta.id] ?? createUsageState();
				const revision = revisionOf.get(meta.id);
				const changed = state.kind !== "persisted" || (revision !== void 0 && revision !== state.revision) || revision === void 0;
				if (changed) {
					try {
						const wasPersisted = state.kind === "persisted";
						const fromSeq = wasPersisted ? state.consumed : 0;
						const events = await readPersistedEvents(persistence, meta.id, fromSeq);
						if (!wasPersisted) {
							state.days = new Map();
							state.lastSample = null;
							state.currentModel = null;
							state.consumed = 0;
						}
						const fresh = wasPersisted ? events.filter((event) => event.seq > (state.consumed ?? 0)) : events;
						const contiguous = fresh.length === 0 ? state.consumed === 0 : fresh[0].seq === state.consumed + 1;
						if (!contiguous && state.consumed > 0) {
							// Log truncated or rewritten: refold the whole log.
							state.days = new Map();
							state.lastSample = null;
							state.currentModel = null;
							state.consumed = 0;
							const allEvents = await readPersistedEvents(persistence, meta.id, 0);
							applyUsageDelta(state, allEvents);
							state.consumed = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : 0;
						} else if (fresh.length > 0) {
							applyUsageDelta(state, fresh);
							state.consumed = fresh[fresh.length - 1].seq;
						}
						state.kind = "persisted";
						if (revision !== void 0) state.revision = revision;
					} catch (error) {
						ctx.logger.warn(`usage-stats: reading persisted session "${meta.id}" failed: ${String(error)}`);
					}
				}
				cache.sessions[meta.id] = state;
			}
		}
		// Only a SUCCESSFUL listing proves a session was deleted. A failed one
		// keeps every cached fold, so a transient storage error cannot erase the
		// history — the payload is flagged `partial` instead.
		if (listingOk) {
			for (const id of Object.keys(cache.sessions)) {
				if (!attached.has(id) && !persistedIds.has(id)) delete cache.sessions[id];
			}
		}
		const byDay = new Map();
		for (const state of Object.values(cache.sessions)) mergeInto(byDay, state.days);
		// Keep the atomic cache write inside the single-flight section. Otherwise
		// overlapping saves can race on the same temporary file.
		await saveCache(ctx, cache);
		const rendered = renderUsage(byDay, Date.now());
		return listingOk ? rendered : { ...rendered, partial: true };
	});
}

/**
 * Rendered usage snapshots are reused for one polling window. Even though the
 * fold itself is incremental, a call still walks every persisted session header
 * and rewrites the cache file (hundreds of milliseconds on a busy DSH_HOME), so
 * the panel's first-open fan-out, a second tab, or a poll landing next to a
 * manual refresh must not repeat it. The window matches the panel's 60s poll, so
 * a poll still observes fresh data; `refresh=1` bypasses the reuse entirely.
 */
const USAGE_SNAPSHOT_TTL_MS = 60000;
let usageSnapshot = { at: 0, value: null };
let usageRefresh = null;

/** The rendered snapshot is also persisted, so a restarted host can answer the
 * panel's first open immediately instead of re-walking every session log (which
 * measured ~40s on a large DSH_HOME). */
function snapshotPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "usage-stats-snapshot.json");
}

/** Read the persisted rendered snapshot; any corruption degrades to "none". */
async function readRenderedSnapshot() {
	try {
		const raw = await readFile(snapshotPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && Number.isFinite(parsed.at) && parsed.value !== null && typeof parsed.value === "object") {
			return { at: parsed.at, value: parsed.value };
		}
	} catch {
		/* first run or corrupt file */
	}
	return null;
}

/** Persist the rendered snapshot atomically (temp + rename); never fatal. */
async function writeRenderedSnapshot(ctx, snapshot) {
	try {
		const path = snapshotPath();
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		await writeFile(tmp, JSON.stringify({ at: snapshot.at, value: snapshot.value }), "utf8");
		await rename(tmp, path);
	} catch (error) {
		ctx.logger.warn(`usage-stats: saving the rendered snapshot failed: ${String(error)}`);
	}
}

/** Test hook: the in-flight background fold, if any. */
export function pendingUsageRefresh() {
	return usageRefresh;
}

/** Recompute in the background (single-flight) and leave the result for the next
 * read, so a slow fold never blocks a panel that already has data on screen. */
function startUsageRefresh(ctx) {
	if (usageRefresh !== null) return usageRefresh;
	usageRefresh = collectUsage(ctx).then(async (value) => {
		usageSnapshot = { at: Date.now(), value };
		await writeRenderedSnapshot(ctx, usageSnapshot);
		return value;
	}).catch((error) => {
		ctx.logger.warn(`usage-stats: background usage refresh failed: ${String(error)}`);
		return null;
	}).finally(() => {
		usageRefresh = null;
	});
	return usageRefresh;
}

/**
 * Read the usage snapshot.
 *
 * `refresh=1` (the panel's ↻ button) always waits for a fresh fold. Everything
 * else is stale-while-revalidate: a value inside the TTL window is returned
 * as-is, and once it expires (or the process just started with nothing in
 * memory) the caller gets the last known snapshot immediately — flagged
 * `stale: true` — while the recompute runs in the background. The panel's next
 * poll then picks up the fresh numbers, so a 40s fold never blanks the chart.
 */
export async function readUsageSnapshot(ctx, force = false) {
	if (force !== true) {
		if (usageSnapshot.value !== null && Date.now() - usageSnapshot.at < USAGE_SNAPSHOT_TTL_MS) {
			return usageSnapshot.value;
		}
		if (usageSnapshot.value === null) {
			const persisted = await readRenderedSnapshot();
			if (persisted !== null) usageSnapshot = persisted;
		}
		if (usageSnapshot.value !== null) {
			startUsageRefresh(ctx);
			return { ...usageSnapshot.value, stale: true };
		}
	}
	const value = await collectUsage(ctx);
	usageSnapshot = { at: Date.now(), value };
	await writeRenderedSnapshot(ctx, usageSnapshot);
	return value;
}

async function handleUsage(ctx, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const result = await readUsageSnapshot(ctx, url.searchParams.get("refresh") === "1");
		json(res, 200, { ok: true, ...result });
	} catch (error) {
		ctx.logger.warn(`usage-stats: usage aggregation failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

//#region session cost (current session + subagent descendants)

/**
 * One session's incremental cost fold, cached across polls. The cache is
 * keyed by session id and invalidated by the storage backend's opaque revision
 * (persisted sessions) or by the in-memory event count (live sessions), so a
 * poll only folds the events added since the previous poll.
 */
const sessionCostCache = new Map();

/** Drop every cached fold (a storage backend switch or test hook). */
export function resetSessionCostCache() {
	sessionCostCache.clear();
}

/** Header facts needed to walk the subagent tree, normalized across backends. */
function sessionHeaderOf(session) {
	const header = session?.header ?? session ?? {};
	return {
		id: typeof session?.id === "string" ? session.id : header.id,
		parentSession: typeof header.parentSession === "string" ? header.parentSession : void 0,
		origin: header.origin === "subagent" ? "subagent" : void 0,
		delegationDepth: typeof header.delegationDepth === "number" ? header.delegationDepth : void 0,
		createdAt: typeof header.createdAt === "number" ? header.createdAt : void 0
	};
}

/** Fold one live session's new events into its cached cost state. */
function foldLiveSessionCost(session) {
	const events = liveSessionEvents(session);
	if (events === null) return null;
	let entry = sessionCostCache.get(session.id);
	if (entry === void 0 || entry.kind !== "live") {
		entry = { kind: "live", consumed: 0, state: createCostState() };
		sessionCostCache.set(session.id, entry);
	}
	if ((entry.consumed ?? 0) < events.length) {
		applyCostDelta(entry.state, events.slice(entry.consumed ?? 0));
		entry.consumed = events.length;
	}
	return entry;
}

/**
 * Fold one stored session's log into its cached cost state. A changed revision
 * means new events, so the log is re-read in full: cost folds are
 * replacement-sensitive and the accumulated state already carries the last
 * sample, which keeps a full re-read exact and free of cross-read drift.
 * Backends that expose no revision get a 60s re-read throttle instead of a
 * full log read on every poll.
 */
async function foldPersistedSessionCost(ctx, persistence, id, revision) {
	const cached = sessionCostCache.get(id);
	const revisionKnown = revision !== void 0;
	let changed = cached === void 0 || cached.kind !== "persisted";
	if (!changed && revisionKnown) changed = cached.revision !== revision;
	else if (!changed && !revisionKnown) changed = Date.now() - (cached.refreshedAt ?? 0) > 60000;
	if (!changed) return cached;
	const events = await readPersistedEvents(persistence, id, 0);
	const entry = { kind: "persisted", revision, consumed: 0, state: createCostState(), refreshedAt: Date.now() };
	applyCostDelta(entry.state, events);
	entry.consumed = events.length > 0 ? events[events.length - 1].seq : 0;
	sessionCostCache.set(id, entry);
	return entry;
}

/** Sum one model row into a merged `Map<model, {tokens, cost, priced}>`. */
function mergeModelRow(merged, row) {
	let entry = merged.get(row.model);
	if (entry === void 0) {
		entry = { model: row.model, tokens: 0, cost: 0, priced: false };
		merged.set(row.model, entry);
	}
	entry.tokens += row.tokens;
	entry.cost += row.cost;
	entry.priced = entry.priced || row.priced === true;
}

/**
 * Estimate the cost of one session plus every subagent descendant.
 * Forks are deliberately excluded: a fork inherits the parent's log, so
 * counting it would charge the parent's tokens twice.
 * @param ctx - plugin context with the `sessions` and `sessionPersistence` services.
 * @param sessionId - the session whose cost is requested.
 * @returns the rendered payload, or null when the session is unknown.
 */
export async function collectSessionCost(ctx, sessionId) {
	const live = ctx.get("sessions");
	const persistence = ctx.get("sessionPersistence");
	/** id → normalized header (live sessions and persisted snapshots merged). */
	const headers = new Map();
	const liveSessions = new Map();
	if (live !== void 0 && typeof live.list === "function") {
		for (const session of live.list()) {
			const header = sessionHeaderOf(session);
			if (typeof header.id !== "string" || header.id === "") continue;
			headers.set(header.id, header);
			liveSessions.set(header.id, session);
		}
	}
	const revisions = new Map();
	let listingOk = false;
	if (persistence !== void 0) {
		const listing = await listPersistedSnapshots(ctx, persistence);
		listingOk = listing.ok;
		for (const entry of listing.snapshots) {
			const header = entry?.header;
			if (header === void 0 || header === null || typeof header.id !== "string") continue;
			if (!headers.has(header.id)) headers.set(header.id, sessionHeaderOf({ ...header, id: header.id }));
			else headers.set(header.id, { ...headers.get(header.id), ...sessionHeaderOf({ ...header, id: header.id }) });
			if (entry.revision !== void 0) revisions.set(header.id, entry.revision);
		}
	}
	if (!headers.has(sessionId)) return null;
	// Subagent tree: children are exactly the sessions whose header names this
	// parent and whose origin is "subagent".
	const children = new Map();
	for (const [id, header] of headers) {
		if (header.origin !== "subagent" || typeof header.parentSession !== "string") continue;
		const list = children.get(header.parentSession);
		if (list === void 0) children.set(header.parentSession, [id]);
		else list.push(id);
	}
	const order = [];
	const seen = new Set();
	const queue = [sessionId];
	while (queue.length > 0) {
		const id = queue.shift();
		if (seen.has(id)) continue;
		seen.add(id);
		order.push(id);
		for (const child of children.get(id) ?? []) queue.push(child);
	}
	const perSession = [];
	let partial = false;
	/** The requested session's rendered fold, whose per-turn rows drive the dialog. */
	let mainRendered = null;
	const mergedModels = new Map();
	const total = {
		tokens: 0,
		hitTokens: 0,
		missTokens: 0,
		writeTokens: 0,
		outputTokens: 0,
		pricedTokens: 0,
		samples: 0,
		cost: 0,
		peakTokens: 0,
		peakCost: 0,
		idleTokens: 0,
		idleCost: 0,
		flatTokens: 0,
		flatCost: 0
	};
	for (const id of order) {
		let entry = null;
		try {
			const session = liveSessions.get(id);
			// A live session that exposes no in-memory event log (older harness)
			// still has its persisted counterpart, so fall through to storage.
			if (session !== void 0) entry = foldLiveSessionCost(session);
			if (entry === null && persistence !== void 0) entry = await foldPersistedSessionCost(ctx, persistence, id, revisions.get(id));
		} catch (error) {
			partial = true;
			ctx.logger.warn(`usage-stats: session cost fold "${id}" failed: ${String(error)}`);
		}
		if (entry === null) {
			partial = true;
			continue;
		}
		const rendered = renderCost(entry.state);
		const role = id === sessionId ? "main" : "subagent";
		const header = headers.get(id) ?? {};
		if (role === "main") mainRendered = rendered;
		perSession.push({
			sessionId: id,
			role,
			delegationDepth: header.delegationDepth,
			createdAt: header.createdAt,
			tokens: rendered.tokens,
			cost: rendered.cost,
			cacheHitRate: rendered.cacheHitRate
		});
		total.tokens += rendered.tokens;
		total.hitTokens += rendered.hitTokens;
		total.missTokens += rendered.missTokens;
		total.writeTokens += rendered.writeTokens;
		total.outputTokens += rendered.outputTokens;
		total.pricedTokens += rendered.pricedTokens;
		total.samples += rendered.samples;
		total.cost += rendered.cost;
		total.peakTokens += rendered.peakTokens;
		total.peakCost += rendered.peakCost;
		total.idleTokens += rendered.idleTokens;
		total.idleCost += rendered.idleCost;
		total.flatTokens += rendered.flatTokens;
		total.flatCost += rendered.flatCost;
		for (const model of rendered.models) mergeModelRow(mergedModels, model);
	}
	// Prune folds for sessions that no longer exist; a failed listing proves
	// nothing, so only a successful one may drop entries.
	if (listingOk) {
		for (const id of [...sessionCostCache.keys()]) {
			if (!headers.has(id) && !liveSessions.has(id)) sessionCostCache.delete(id);
		}
	}
	const promptTokens = total.hitTokens + total.missTokens + total.writeTokens;
	const cacheHitRate = promptTokens > 0 ? Math.round((total.hitTokens / promptTokens) * 1000) / 10 : null;
	const main = perSession.find((entry) => entry.role === "main") ?? null;
	const subagents = perSession.filter((entry) => entry.role === "subagent");
	const models = [...mergedModels.values()]
		.map((entry) => ({ model: entry.model, tokens: entry.tokens, cost: Math.round(entry.cost * 10000) / 10000, priced: entry.priced }))
		.sort((a, b) => b.tokens - a.tokens);
	// Per-turn rows for the "本轮用量" dialog. A subagent session is attributed to
	// the turn that was running when the child session was created: child headers
	// carry createdAt, and the turn's own usage samples bracket that instant.
	const turns = (mainRendered?.turns ?? []).map((entry) => ({
		turn: entry.turn,
		tokens: entry.tokens,
		mainCost: entry.cost,
		subagentCost: 0,
		subagentTokens: 0,
		subagentSessions: 0,
		totalCost: entry.cost,
		startTime: entry.startTime,
		endTime: entry.endTime
	}));
	if (turns.length > 0) {
		for (const child of subagents) {
			if (typeof child.createdAt !== "number") continue;
			let target = turns[0];
			for (const turn of turns) {
				if (typeof turn.startTime !== "number") continue;
				if (child.createdAt >= turn.startTime) target = turn;
				else break;
			}
			target.subagentCost += child.cost;
			target.subagentTokens += child.tokens;
			target.subagentSessions += 1;
			target.totalCost = Math.round((target.mainCost + target.subagentCost) * 10000) / 10000;
			target.subagentCost = Math.round(target.subagentCost * 10000) / 10000;
		}
	}
	return {
		ok: true,
		sessionId,
		generatedAt: Date.now(),
		partial,
		turns,
		total: {
			tokens: total.tokens,
			hitTokens: total.hitTokens,
			missTokens: total.missTokens,
			writeTokens: total.writeTokens,
			outputTokens: total.outputTokens,
			pricedTokens: total.pricedTokens,
			cacheHitRate,
			samples: total.samples,
			cost: Math.round(total.cost * 10000) / 10000,
			currency: "CNY",
			peakTokens: total.peakTokens,
			peakCost: Math.round(total.peakCost * 10000) / 10000,
			idleTokens: total.idleTokens,
			idleCost: Math.round(total.idleCost * 10000) / 10000,
			flatTokens: total.flatTokens,
			flatCost: Math.round(total.flatCost * 10000) / 10000,
			models
		},
		main: main === null ? null : { tokens: main.tokens, cost: main.cost },
		subagents: {
			count: subagents.length,
			tokens: subagents.reduce((sum, entry) => sum + entry.tokens, 0),
			cost: Math.round(subagents.reduce((sum, entry) => sum + entry.cost, 0) * 10000) / 10000,
			sessions: subagents
		}
	};
}

/** GET /api/usage-stats/session?sessionId=… — loopback-only, GET-only. */
async function handleSessionCost(ctx, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const sessionId = url.searchParams.get("sessionId") ?? "";
		if (sessionId === "" || sessionId.length > 200) {
			json(res, 400, { ok: false, error: "invalid-session" });
			return;
		}
		const result = await collectSessionCost(ctx, sessionId);
		if (result === null) {
			json(res, 404, { ok: false, error: "unknown-session" });
			return;
		}
		json(res, 200, result);
	} catch (error) {
		ctx.logger.warn(`usage-stats: session cost failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

//#endregion session cost

/**
 * The official DeepSeek connection facts from the harness settings
 * (`llm-deepseek` namespace), falling back to the public defaults. This
 * plugin is DeepSeek-only, so it never enumerates other providers.
 */
function deepseekProvider(ctx) {
	const settings = ctx.get("settings");
	const deepseek = settings?.get?.("llm-deepseek");
	if (deepseek !== void 0 && deepseek !== null && typeof deepseek === "object") {
		return {
			id: "deepseek-official",
			displayName: "DeepSeek",
			apiKeyEnv: typeof deepseek.apiKeyEnv === "string" ? deepseek.apiKeyEnv : DEEPSEEK_DEFAULTS.apiKeyEnv,
			baseURL: typeof deepseek.baseURL === "string" ? deepseek.baseURL : DEEPSEEK_DEFAULTS.baseURL
		};
	}
	return {
		id: "deepseek-official",
		displayName: "DeepSeek",
		apiKeyEnv: DEEPSEEK_DEFAULTS.apiKeyEnv,
		baseURL: DEEPSEEK_DEFAULTS.baseURL
	};
}

/** DeepSeek balance endpoint; cached by default, `refresh=1` forces upstream. */
async function handleAccount(ctx, accounts, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const account = await accounts.get("deepseek-official", { force: url.searchParams.get("refresh") === "1" });
		if (account === null) {
			json(res, 200, { ok: false, error: "unknown-provider", message: "DeepSeek is not configured" });
			return;
		}
		json(res, 200, { ok: true, account });
	} catch (error) {
		ctx.logger.warn(`usage-stats: account fetch failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

//#region platform usage (DeepSeek web usage token, not the API key)
/** Per-month cache entries: `{ at, result }`; single-flight per month key. */
const platformCache = new Map();
const platformInflight = new Map();

/**
 * Every platform cache below is only valid for the credential that filled it.
 * Each collector resolves the token first and hands it to
 * `platformCacheGeneration()`: a changed credential bumps the generation and
 * drops month/day/total entries, so switching accounts can never serve the
 * previous account's numbers. In-flight requests snapshot the generation before
 * their fetch and discard the result when it has moved on, and the single-flight
 * key carries the generation so a request started under the old credential is
 * never handed to the new one. The token is compared in memory only: it is
 * never logged and never becomes part of a cache key.
 */
let platformCacheEpoch = 0;
let platformCacheCredential = null;

function dropPlatformCaches() {
	platformCache.clear();
	platformDayCache.clear();
	platformTotalMonthCache.clear();
	platformTotalSummary.at = 0;
	platformTotalSummary.result = null;
}

function platformCacheGeneration(token) {
	if (platformCacheCredential !== token) {
		platformCacheCredential = token;
		platformCacheEpoch += 1;
		dropPlatformCaches();
	}
	return platformCacheEpoch;
}

/** Saving or clearing the token invalidates every platform cache immediately. */
function resetPlatformCaches() {
	platformCacheCredential = null;
	platformCacheEpoch += 1;
	dropPlatformCaches();
}

const PLATFORM_DAY_PATH = "/api/usage-stats/platform/day";
const PLATFORM_TOTAL_PATH = "/api/usage-stats/platform/total";
const PLATFORM_TOKEN_PATH = "/api/usage-stats/platform/token";
const PLATFORM_TOKEN_MAX_BYTES = 8192;
const PLATFORM_SYNC_PATH = "/api/usage-stats/platform/sync";

/** Plugin-managed usage-token file written by the panel settings; never sent to the browser. */
function platformTokenFile() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "usage-stats-platform.json");
}

/** In-memory mirror of the stored token; null = not loaded yet. */
let storedUsageToken = null;

async function readStoredUsageToken() {
	try {
		const parsed = JSON.parse(await readFile(platformTokenFile(), "utf8"));
		if (parsed !== null && typeof parsed === "object" && parsed.version === 1 && typeof parsed.usageToken === "string") {
			return parsed.usageToken.trim();
		}
	} catch {
		/* missing or corrupt storage */
	}
	return "";
}

async function loadStoredUsageToken() {
	if (storedUsageToken === null) storedUsageToken = await readStoredUsageToken();
	return storedUsageToken;
}

async function writeStoredUsageToken(token) {
	const path = platformTokenFile();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, JSON.stringify({ version: 1, usageToken: token }), { encoding: "utf8", mode: 0o600 });
	await rename(temporary, path);
	storedUsageToken = token;
}

async function saveUsageToken(token) {
	await writeStoredUsageToken(token.trim());
	resetPlatformCaches();
}

async function clearUsageToken() {
	await writeStoredUsageToken("");
	resetPlatformCaches();
}

/**
 * Resolve the DeepSeek usage token: the configured credential ref wins (the
 * value of `localStorage.userToken` on platform.deepseek.com — a session
 * credential, never the API key), otherwise the token saved through the panel
 * settings. Either way it stays server-side and never reaches the browser or
 * the logs.
 */
async function resolveUsageTokenSources(ctx, ref) {
	const credentials = ctx.get("credentials") ?? ctx.credentials;
	let fromCredential = "";
	if (credentials !== void 0 && credentials !== null && typeof credentials.resolve === "function") {
		try {
			const hit = await credentials.resolve(ref);
			fromCredential = typeof hit?.value === "string" ? hit.value.trim() : "";
		} catch {
			/* keep the stored fallback */
		}
	}
	const stored = await loadStoredUsageToken();
	return { fromCredential, stored };
}

async function resolveUsageToken(ctx, ref) {
	const { fromCredential, stored } = await resolveUsageTokenSources(ctx, ref);
	return fromCredential !== "" ? fromCredential : stored;
}

/**
 * Fetch (or serve from cache) one month of DeepSeek platform usage.
 * Returns null when the usage token is not configured; throws on upstream
 * failures. `force` bypasses the in-memory five-minute cache.
 */
async function collectPlatformUsage(ctx, { month, year, force = false, ref } = {}) {
	const { month: m, year: y } = normalizeMonthYear(month, year);
	const key = `${y}-${String(m).padStart(2, "0")}`;
	const token = await resolveUsageToken(ctx, ref ?? DEEPSEEK_USAGE_TOKEN_REF);
	if (token === "") return null;
	const epoch = platformCacheGeneration(token);
	const flightKey = `${key}|${epoch}`;
	if (!force) {
		const hit = platformCache.get(key);
		if (hit !== void 0 && Date.now() - hit.at < PLATFORM_REFRESH_MS) return hit.result;
	}
	const inflight = platformInflight.get(flightKey);
	if (inflight !== void 0) return inflight;
	const run = fetchPlatformUsageSmart(token, { month: m, year: y, timeoutMs: UPSTREAM_TIMEOUT_MS }).then((result) => {
		if (epoch === platformCacheEpoch) platformCache.set(key, { at: Date.now(), result });
		return result;
	}).finally(() => {
		platformInflight.delete(flightKey);
	});
	platformInflight.set(flightKey, run);
	return run;
}

/** DeepSeek platform usage route: `?month=&year=` (default current), `refresh=1` forces upstream. */
async function handlePlatform(ctx, req, res, usageRef) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		let params;
		try {
			params = normalizeMonthYear(url.searchParams.get("month"), url.searchParams.get("year"));
		} catch (error) {
			json(res, 400, { ok: false, error: "invalid-params", message: error instanceof Error ? error.message : String(error) });
			return;
		}
		const result = await collectPlatformUsage(ctx, {
			month: params.month,
			year: params.year,
			force: url.searchParams.get("refresh") === "1",
			ref: usageRef
		});
		if (result === null) {
			json(res, 200, { ok: false, error: "no-credential", message: usageRef });
			return;
		}
		json(res, 200, { ok: true, fetchedAt: Date.now(), ...result });
	} catch (error) {
		const status = error?.providerStatus ?? "failed";
		ctx.logger.warn(`usage-stats: platform usage fetch failed: ${String(error)}`);
		json(res, status === "invalid-params" ? 400 : 502, {
			ok: false,
			error: status,
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

/**
 * All-time platform token total, computed by a month-by-month backward scan
 * (the platform web interface caps a single query at roughly one month).
 * Per-month sums and the aggregate are cached in memory (5 min). Returns
 * null when the usage token is not configured.
 */
const platformTotalSummary = { at: 0, result: null };
const platformTotalMonthCache = new Map();
let platformTotalInflight = null;
let platformTotalInflightEpoch = -1;
const PLATFORM_TOTAL_MAX_MONTHS = 24;

/**
 * One month's token sum for the cumulative walk. Finished months are cached for
 * `PLATFORM_HISTORY_REFRESH_MS` (the walk revisits up to 24 of them per scan) and
 * the month in progress for the regular five minutes. A forced scan bypasses the
 * sub-cache entirely — otherwise the ↻ button would re-read stale month sums.
 */
async function collectPlatformMonthTokenTotal(ctx, token, month, year, { force = false } = {}) {
	const key = `${year}-${String(month).padStart(2, "0")}`;
	const current = normalizeMonthYear(void 0, void 0);
	const ttl = `${current.year}-${String(current.month).padStart(2, "0")}` === key ? PLATFORM_REFRESH_MS : PLATFORM_HISTORY_REFRESH_MS;
	const epoch = platformCacheEpoch;
	if (!force) {
		const hit = platformTotalMonthCache.get(key);
		if (hit !== void 0 && Date.now() - hit.at < ttl) return hit.total;
	}
	const total = await fetchPlatformMonthTokenSum(token, { month, year, timeoutMs: UPSTREAM_TIMEOUT_MS });
	if (epoch === platformCacheEpoch) platformTotalMonthCache.set(key, { at: Date.now(), total });
	return total;
}

async function collectPlatformTotal(ctx, { force = false, ref } = {}) {
	const token = await resolveUsageToken(ctx, ref ?? DEEPSEEK_USAGE_TOKEN_REF);
	if (token === "") return null;
	const epoch = platformCacheGeneration(token);
	if (!force && platformTotalSummary.result !== null) {
		const ttl = platformTotalSummary.result.partial === true ? PLATFORM_TOTAL_PARTIAL_REFRESH_MS : PLATFORM_REFRESH_MS;
		if (Date.now() - platformTotalSummary.at < ttl) return platformTotalSummary.result;
	}
	if (platformTotalInflight !== null && platformTotalInflightEpoch === epoch) return platformTotalInflight;
	const run = fetchPlatformCumulativeTokenTotal(token, {
		timeoutMs: UPSTREAM_TIMEOUT_MS,
		maxMonths: PLATFORM_TOTAL_MAX_MONTHS,
		budgetMs: PLATFORM_TOTAL_BUDGET_MS,
		monthTotal: (month, year) => collectPlatformMonthTokenTotal(ctx, token, month, year, { force })
	}).then((result) => {
		if (epoch === platformCacheEpoch) {
			platformTotalSummary.at = Date.now();
			platformTotalSummary.result = result;
		}
		return result;
	}).finally(() => {
		if (platformTotalInflight === run) {
			platformTotalInflight = null;
			platformTotalInflightEpoch = -1;
		}
	});
	platformTotalInflight = run;
	platformTotalInflightEpoch = epoch;
	return run;
}

/**
 * One day's finer-grained platform usage (hourly buckets + per-API-Key and
 * per-model day totals), cached per day for five minutes.
 */
const platformDayCache = new Map();
const platformDayInflight = new Map();

async function collectPlatformDay(ctx, { date, force = false, ref } = {}) {
	const token = await resolveUsageToken(ctx, ref ?? DEEPSEEK_USAGE_TOKEN_REF);
	if (token === "") return null;
	const epoch = platformCacheGeneration(token);
	const flightKey = `${date}|${epoch}`;
	if (!force) {
		const hit = platformDayCache.get(date);
		if (hit !== void 0 && Date.now() - hit.at < PLATFORM_REFRESH_MS) return hit.result;
	}
	const inflight = platformDayInflight.get(flightKey);
	if (inflight !== void 0) return inflight;
	const run = fetchPlatformDayDetail(token, { date, timeoutMs: UPSTREAM_TIMEOUT_MS }).then((result) => {
		if (epoch === platformCacheEpoch) platformDayCache.set(date, { at: Date.now(), result });
		return result;
	}).finally(() => {
		platformDayInflight.delete(flightKey);
	});
	platformDayInflight.set(flightKey, run);
	return run;
}

/** Platform day route: `?date=YYYY-MM-DD` (GMT+8); GET only; `refresh=1` bypasses the cache. */
async function handlePlatformDay(ctx, req, res, usageRef) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const date = url.searchParams.get("date") ?? "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			json(res, 400, { ok: false, error: "invalid-params", message: "date must be YYYY-MM-DD" });
			return;
		}
		const result = await collectPlatformDay(ctx, { date, force: url.searchParams.get("refresh") === "1", ref: usageRef });
		if (result === null) {
			json(res, 200, { ok: false, error: "no-credential", message: usageRef });
			return;
		}
		json(res, 200, { ok: true, fetchedAt: Date.now(), ...result });
	} catch (error) {
		const status = error?.providerStatus ?? "failed";
		ctx.logger.warn(`usage-stats: platform day fetch failed: ${String(error)}`);
		json(res, status === "invalid-params" ? 400 : 502, {
			ok: false,
			error: status,
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

/** Live peak/idle pricing state. The schedule is deterministic, so a 30-second
 * cache is enough — the panel only needs minute-level freshness for its countdown. */
const PRICE_PERIOD_REFRESH_MS = 30000;
let pricePeriodCache = { at: 0, value: null };

/**
 * GET /api/usage-stats/price-period — the live peak/idle billing state plus the
 * current price rows. Loopback-only and GET-only; it never touches credentials.
 */
async function handlePricePeriod(req, res) {
	if (rejectForeignCaller(req, res)) return;
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return;
	}
	const now = Date.now();
	if (pricePeriodCache.value === null || now - pricePeriodCache.at >= PRICE_PERIOD_REFRESH_MS) {
		pricePeriodCache = { at: now, value: describePricePeriod(now) };
	}
	json(res, 200, { ok: true, fetchedAt: now, ...pricePeriodCache.value, calendar: holidayCalendarInfo() });
}

/** Platform all-time token total route: GET only; `refresh=1` bypasses the cache. */
async function handlePlatformTotal(ctx, req, res, usageRef) {
	if (rejectForeignCaller(req, res)) return;
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return;
	}
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const result = await collectPlatformTotal(ctx, { force: url.searchParams.get("refresh") === "1", ref: usageRef });
		if (result === null) {
			json(res, 200, { ok: false, error: "no-credential", message: usageRef });
			return;
		}
		json(res, 200, { ok: true, fetchedAt: Date.now(), ...result });
	} catch (error) {
		const status = error?.providerStatus ?? "failed";
		ctx.logger.warn(`usage-stats: platform total fetch failed: ${String(error)}`);
		json(res, status === "invalid-params" ? 400 : 502, {
			ok: false,
			error: status,
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

/** `http://host:3080` → `host:3080`; an absent or default port is dropped. */
function originHostOf(value) {
	if (typeof value !== "string" || value.trim() === "") return null;
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const port = url.port === "" || url.port === (url.protocol === "https:" ? "443" : "80") ? "" : `:${url.port}`;
	return `${url.hostname.toLowerCase()}${port}`;
}

/** `localhost:3080` → `localhost:3080`; an absent or default port is dropped. */
function hostHeaderOrigin(req) {
	const host = typeof req.headers?.host === "string" ? req.headers.host.trim().toLowerCase() : "";
	if (host === "") return null;
	const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
	if (match === null) return null;
	const port = match[2] === void 0 || match[2] === "80" || match[2] === "443" ? "" : `:${match[2]}`;
	return `${match[1]}${port}`;
}

/**
 * Same-origin fence for the routes that write or act (token save/clear, login
 * sync). The loopback peer check alone cannot tell the panel apart from a
 * cross-site page running in the user's own browser — that request also arrives
 * from 127.0.0.1. Browsers label those requests with a foreign `Origin` and
 * `Sec-Fetch-Site: cross-site`, so both are checked here.
 *
 * A request WITHOUT an Origin stays allowed: that is the documented path for
 * local tools (curl, PowerShell, native clients). Browsers always send the
 * header for the cross-site cases this fence exists to refuse.
 */
function rejectCrossSiteCaller(req, res) {
	const site = req.headers?.["sec-fetch-site"];
	if (typeof site === "string" && site !== "same-origin" && site !== "none") {
		json(res, 403, { ok: false, error: "forbidden" });
		return true;
	}
	const origin = req.headers?.origin;
	if (origin !== void 0) {
		const source = originHostOf(origin);
		const expected = hostHeaderOrigin(req);
		if (source === null || expected === null || source !== expected) {
			json(res, 403, { ok: false, error: "forbidden" });
			return true;
		}
	}
	// A request body must be JSON. Form content types (`text/plain`,
	// `application/x-www-form-urlencoded`, `multipart/form-data`) are exactly
	// what a cross-site page can post without a CORS preflight.
	const declaredLength = Number(req.headers?.["content-length"] ?? 0);
	const hasBody = (Number.isFinite(declaredLength) && declaredLength > 0) || req.headers?.["transfer-encoding"] !== void 0;
	if (hasBody) {
		const type = typeof req.headers?.["content-type"] === "string" ? req.headers["content-type"].split(";")[0].trim().toLowerCase() : "";
		if (type !== "application/json") {
			json(res, 415, { ok: false, error: "unsupported-media-type" });
			return true;
		}
	}
	return false;
}

/**
 * Loopback + same-origin fence for the token settings route: GET (status),
 * POST (save) and DELETE (clear) are allowed; anything else, any non-loopback
 * caller or any cross-site browser request is refused before the body is read.
 */
function rejectForeignTokenCaller(req, res) {
	if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (!isLoopbackAddress(peer) || !isLoopbackHostHeader(req)) {
		json(res, 403, { ok: false, error: "forbidden" });
		return true;
	}
	return rejectCrossSiteCaller(req, res);
}

/** Read a small JSON request body (size-limited). */
function readJsonBody(req, maxBytes) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Usage-token settings route. GET returns only the configured/source status
 * (never the token); POST saves a token (written with restricted permissions
 * under DSH_HOME/storages); DELETE clears it. Saving a token makes the next
 * platform query succeed immediately — the client refreshes right away.
 */
async function handlePlatformToken(ctx, req, res, ref) {
	if (rejectForeignTokenCaller(req, res)) return;
	try {
		if (req.method === "GET") {
			const { fromCredential, stored } = await resolveUsageTokenSources(ctx, ref ?? DEEPSEEK_USAGE_TOKEN_REF);
			const source = fromCredential !== "" ? "credential" : stored !== "" ? "stored" : null;
			json(res, 200, { ok: true, configured: source !== null, source, version: PLUGIN_VERSION });
			return;
		}
		if (req.method === "POST") {
			const body = await readJsonBody(req, PLATFORM_TOKEN_MAX_BYTES);
			const token = typeof body?.token === "string" ? body.token.trim() : "";
			if (token === "") {
				json(res, 400, { ok: false, error: "invalid-token", message: "token must be a non-empty string" });
				return;
			}
			await saveUsageToken(token);
			json(res, 200, { ok: true, configured: true, source: "stored" });
			return;
		}
		await clearUsageToken();
		json(res, 200, { ok: true, configured: false, source: null });
	} catch (error) {
		ctx.logger.warn(`usage-stats: platform token settings failed: ${String(error)}`);
		json(res, 400, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Web-login auto-sync route. POST starts a sync session (opens a system
 * browser window at platform.deepseek.com; the captured and verified token is
 * saved automatically and the window closes); GET reports whether a session
 * is running plus the last result; DELETE cancels. Errors are reported with a
 * stable `error` code so the UI can offer the manual-paste fallback.
 */
async function handlePlatformSync(ctx, loginSync, req, res) {
	if (rejectForeignTokenCaller(req, res)) return;
	try {
		if (req.method === "POST") {
			const result = await loginSync.start();
			json(res, 200, { ok: true, ...result });
			return;
		}
		if (req.method === "DELETE") {
			await loginSync.cancel();
			json(res, 200, { ok: true, running: false });
			return;
		}
		const status = loginSync.status();
		json(res, 200, { ok: true, running: status.running, last: status.last });
	} catch (error) {
		const code = error?.code ?? "sync-failed";
		ctx.logger.warn(`usage-stats: platform login sync failed: ${String(error)}`);
		json(res, 200, { ok: false, error: code, message: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion

/**
 * Keep the statutory-holiday calendar current: apply the cached copy immediately
 * (pricing still works offline), then refresh from the public calendar sources
 * twice a day. Sync failures only delay newly announced holidays; the built-in
 * and cached dates stay active.
 */
function startHolidaySync(ctx) {
	let cancelled = false;
	const sync = () => {
		refreshHolidayCalendar().then((result) => {
			if (cancelled) return;
			if (result.failures.length > 0) {
				ctx.logger.warn(`usage-stats: holiday calendar sync partial: ${JSON.stringify(result.failures)}`);
			}
		}).catch((error) => {
			if (!cancelled) ctx.logger.warn(`usage-stats: holiday calendar sync failed: ${String(error)}`);
		});
	};
	loadHolidayCache().catch(() => void 0).finally(sync);
	const timer = setInterval(sync, 12 * 3600 * 1000);
	if (typeof timer.unref === "function") timer.unref();
	return () => {
		cancelled = true;
		clearInterval(timer);
	};
}

/** Start an immediate refresh and repeat account + local usage refresh every 5 minutes. */
export function startBackgroundRefresh(ctx, accounts, deps = {}) {
	let running = false;
	let stopped = false;
	let active = Promise.resolve();
	const run = async () => {
		if (running || stopped) return;
		running = true;
		active = (async () => {
			const results = await Promise.allSettled([
				accounts.refreshAll(),
				readUsageSnapshot(ctx, true),
				collectPlatformUsage(ctx, { ref: deps.usageTokenRef ?? DEEPSEEK_USAGE_TOKEN_REF }).catch(() => null)
			]);
			for (const result of results) if (result.status === "rejected") ctx.logger.warn(`usage-stats: background refresh failed: ${String(result.reason)}`);
		})().finally(() => {
			running = false;
		});
		return active;
	};
	void run();
	const setTimer = deps.setInterval ?? setInterval;
	const clearTimer = deps.clearInterval ?? clearInterval;
	const timer = setTimer(run, deps.intervalMs ?? ACCOUNT_REFRESH_MS);
	timer?.unref?.();
	const stop = async () => {
		stopped = true;
		clearTimer(timer);
		await active;
	};
	stop.refreshNow = async () => {
		await active;
		return run();
	};
	return stop;
}

/**
 * Plugin body: register the seven exact routes and start background refresh.
 * @param ctx - plugin context carrying webServer, credentials, sessions, sessionPersistence, and settings.
 */
const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-usage-stats",
		validate(value) {
			try {
				return { value: validateAccountConfig(value ?? {}) };
			} catch (error) {
				return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
			}
		}
	}
};

async function apply(ctx, rawConfig = {}, deps = {}) {
	const config = validateAccountConfig(rawConfig);
	// One effective credential reference for every platform route: the settings
	// page, the background refresh and month/total/day must agree, otherwise a
	// custom `usageTokenRef` reports "configured" while the queries say
	// "no-credential".
	const usageRef = config.usageTokenRef ?? DEEPSEEK_USAGE_TOKEN_REF;
	const provider = deepseekProvider(ctx);
	const accounts = deps.accounts ?? createAccountService({
		credentials: ctx.get("credentials") ?? ctx.credentials,
		deps: {
			timeoutMs: UPSTREAM_TIMEOUT_MS,
			apiKeyRef: provider.apiKeyEnv,
			baseURL: provider.baseURL
		}
	});
	await accounts.validate();
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: USAGE_PATH,
		handler: (req, res) => handleUsage(ctx, req, res)
	}), "usage-stats: usage route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SESSION_COST_PATH,
		handler: (req, res) => handleSessionCost(ctx, req, res)
	}), "usage-stats: session cost route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ACCOUNT_PATH,
		handler: (req, res) => handleAccount(ctx, accounts, req, res)
	}), "usage-stats: account route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PLATFORM_PATH,
		handler: (req, res) => handlePlatform(ctx, req, res, usageRef)
	}), "usage-stats: platform route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PRICE_PERIOD_PATH,
		handler: (req, res) => handlePricePeriod(req, res)
	}), "usage-stats: price period route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PLATFORM_TOTAL_PATH,
		handler: (req, res) => handlePlatformTotal(ctx, req, res, usageRef)
	}), "usage-stats: platform total route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PLATFORM_DAY_PATH,
		handler: (req, res) => handlePlatformDay(ctx, req, res, usageRef)
	}), "usage-stats: platform day route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PLATFORM_TOKEN_PATH,
		handler: (req, res) => handlePlatformToken(ctx, req, res, config.usageTokenRef)
	}), "usage-stats: platform token route");
	const loginSync = deps.loginSync ?? createLoginSync({
		userDataDir: join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "usage-stats", "browser-profile"),
		verify: (token) => verifyUsageToken(token, { timeoutMs: UPSTREAM_TIMEOUT_MS }),
		save: saveUsageToken
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PLATFORM_SYNC_PATH,
		handler: (req, res) => handlePlatformSync(ctx, loginSync, req, res)
	}), "usage-stats: platform sync route");
	if (deps.disableBackgroundRefresh !== true) {
		ctx.effect(() => startBackgroundRefresh(ctx, accounts, { usageTokenRef: usageRef }), "usage-stats: background account refresh");
		// 节假日日历自动同步：先读缓存立刻生效，再联网更新（失败只影响"新公告"，不影响已知假日）。
		ctx.effect(() => startHolidaySync(ctx), "usage-stats: holiday calendar sync");
	}
}

export { apply, Config, inject, name, USAGE_PATH, SESSION_COST_PATH, ACCOUNT_PATH, PLATFORM_PATH, PRICE_PERIOD_PATH, PLATFORM_TOTAL_PATH, PLATFORM_DAY_PATH, PLATFORM_TOKEN_PATH, PLATFORM_SYNC_PATH, deepseekProvider, totalTokens, zeroBuckets };
