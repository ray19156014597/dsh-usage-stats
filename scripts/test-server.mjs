import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function usageEvent(seq, inputTokens) {
	return {
		seq,
		time: Date.UTC(2026, 7, 13),
		type: "assistant/message",
		data: {
			turn: `turn-${seq}`,
			step: 0,
			usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			message: { source: { model: "deepseek-chat" } }
		}
	};
}

async function freshModule(label, home) {
	process.env.DSH_HOME = home;
	return import(new URL(`../lib/index.js?test=${label}-${Date.now()}-${Math.random()}`, import.meta.url));
}

function makeResponse() {
	return {
		status: null,
		body: "",
		writeHead(status) { this.status = status; },
		end(body = "") { this.body = body; }
	};
}

function makeContext({ sessions, persistence, routes, settings } = {}) {
	return {
		logger: { warn: () => {} },
		credentials: { resolve: async () => void 0 },
		webServer: { register: (entry) => { routes?.set(entry.path, entry.handler); return () => {}; } },
		effect: (register) => register(),
		get: (name) => name === "sessions" ? sessions : name === "sessionPersistence" ? persistence : name === "settings" ? settings : void 0
	};
}

async function testRouteFence(root) {
	const plugin = await freshModule("routes", join(root, "routes"));
	const routes = new Map();
	const empty = { list: () => [] };
	const persistence = { listSnapshots: async () => [], list: async () => [] };
	await plugin.apply(makeContext({ sessions: empty, persistence, routes }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.USAGE_PATH);
	assert.equal(typeof handler, "function");

	const ipv6 = makeResponse();
	await handler({ method: "GET", headers: { host: "[::1]:3080" }, socket: { remoteAddress: "::1" } }, ipv6);
	assert.equal(ipv6.status, 200, "bracketed IPv6 loopback must be accepted");

	const foreign = makeResponse();
	await handler({ method: "GET", headers: { host: "localhost:3080" }, socket: { remoteAddress: "203.0.113.7" } }, foreign);
	assert.equal(foreign.status, 403, "a spoofed Host must not bypass the peer fence");

	const head = makeResponse();
	await handler({ method: "HEAD", headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, head);
	assert.equal(head.status, 405, "the endpoints are GET-only");

	assert.equal(plugin.SUBSCRIPTIONS_PATH, void 0, "the multi-provider subscription route must be gone");
	assert.equal(plugin.PROVIDERS_PATH, void 0, "the multi-provider providers route must be gone");
	assert.equal(plugin.BALANCE_PATH, void 0, "the legacy balance route must be gone");

	const account = makeResponse();
	await routes.get(plugin.ACCOUNT_PATH)({ method: "GET", url: `${plugin.ACCOUNT_PATH}?provider=deepseek-official`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, account);
	assert.equal(account.status, 200);
	assert.equal(JSON.parse(account.body).account.status, "not-configured");

	// Live peak/idle pricing state: loopback-only, GET-only, no credentials needed.
	const periodHandler = routes.get(plugin.PRICE_PERIOD_PATH);
	assert.equal(typeof periodHandler, "function", "the price-period route must be registered");
	const period = makeResponse();
	await periodHandler({ method: "GET", headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, period);
	assert.equal(period.status, 200);
	const periodBody = JSON.parse(period.body);
	assert.equal(periodBody.ok, true);
	assert.ok(["peak", "idle", "flat"].includes(periodBody.period), "period must be peak/idle/flat");
	assert.equal(typeof periodBody.prices?.flash?.hit, "number", "current Flash price row must be included");
	assert.equal(periodBody.calendar?.builtin, true, "without a sync the built-in holiday calendar is reported");
	assert.ok(Array.isArray(periodBody.calendar?.years), "calendar years must be reported");
	const periodPost = makeResponse();
	await periodHandler({ method: "POST", headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, periodPost);
	assert.equal(periodPost.status, 405, "the price-period route is GET-only");
	const periodForeign = makeResponse();
	await periodHandler({ method: "GET", headers: { host: "localhost:3080" }, socket: { remoteAddress: "203.0.113.7" } }, periodForeign);
	assert.equal(periodForeign.status, 403, "the price-period route must stay loopback-only");
}

async function testConfigValidation(root) {
	const plugin = await freshModule("config", join(root, "config"));
	assert.equal(plugin.Config["~standard"].validate({}).issues, void 0);
	assert.equal(plugin.Config["~standard"].validate({ usageTokenRef: "DEEPSEEK_USAGE_TOKEN" }).issues, void 0);
	assert.match(plugin.Config["~standard"].validate({ usageTokenRef: "" }).issues[0].message, /usageTokenRef/);
	const routes = new Map();
	const context = makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] },
		routes,
		settings: { get: () => void 0 }
	});
	await plugin.apply(context, { usageTokenRef: "DEEPSEEK_USAGE_TOKEN" }, { disableBackgroundRefresh: true });
	assert.equal(routes.size, 9, "the DeepSeek-only plugin must register exactly nine routes");
	assert.deepEqual(await plugin.deepseekProvider(context), {
		id: "deepseek-official",
		displayName: "DeepSeek",
		apiKeyEnv: "DEEPSEEK_API_KEY",
		baseURL: "https://api.deepseek.com"
	});
}

async function testBackgroundRefresh(root) {
	const plugin = await freshModule("background", join(root, "background"));
	let refreshes = 0;
	let interval = null;
	let tick = null;
	let cleared = false;
	const ctx = makeContext({
		sessions: { list: () => [] },
		persistence: { listSnapshots: async () => [], list: async () => [] }
	});
	const cleanup = plugin.startBackgroundRefresh(ctx, {
		refreshAll: async () => { refreshes += 1; }
	}, {
		setInterval: (callback, ms) => {
			tick = callback;
			interval = ms;
			return { unref: () => {} };
		},
		clearInterval: () => { cleared = true; }
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(interval, 300000);
	assert.equal(refreshes, 1, "background refresh must run immediately at startup");
	assert.equal(typeof tick, "function");
	await cleanup.refreshNow();
	assert.equal(refreshes, 2, "the five-minute timer must refresh accounts again");
	await cleanup();
	assert.equal(cleared, true);
}

async function testPersistedToLive(root) {
	const plugin = await freshModule("transition", join(root, "transition"));
	const id = "transition-session";
	const persisted = usageEvent(100, 11);
	let live = false;
	const sessions = { list: () => live ? [{ id, events: [usageEvent(1, 7)] }] : [] };
	const persistence = {
		listSnapshots: async () => live ? [] : [{ header: { id }, revision: "r1" }],
		list: async () => [],
		readFrom: async () => ({ events: [persisted] })
	};
	const ctx = makeContext({ sessions, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 11);
	live = true;
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 7, "persisted-to-live must refold the full live log");
}

async function testRevisionRewrite(root) {
	const plugin = await freshModule("rewrite", join(root, "rewrite"));
	const id = "rewritten-session";
	let revision = "r1";
	let reads = 0;
	const persistence = {
		listSnapshots: async () => [{ header: { id }, revision }],
		list: async () => [],
		readFrom: async (_id, fromSeq) => {
			reads += 1;
			if (revision === "r1") return { events: [usageEvent(100, 11)] };
			return { events: fromSeq === 0 ? [usageEvent(1, 5)] : [] };
		}
	};
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 11);
	await plugin.collectUsage(ctx);
	assert.equal(reads, 1, "an unchanged opaque revision must skip storage reads");
	revision = "r2";
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 5, "a rewritten log must replace cached usage");
	assert.equal(reads, 3, "rewrite detection must retry from seq 0");
}

/**
 * Harness-version drift: dsh 0.1.2 removed the live session's `events` array
 * getter in favour of `snapshotEvents(fromSeq, toSeqExclusive)` + `seq`. The
 * aggregator must read both shapes, and one unreadable session must never
 * fail the whole route (it used to 500 with "Cannot read properties of
 * undefined (reading 'length')").
 */
async function testLiveSessionApiDrift(root) {
	const plugin = await freshModule("drift", join(root, "drift"));
	const log = [usageEvent(1, 5), usageEvent(2, 6)];
	const modern = {
		id: "modern-session",
		seq: log.length,
		snapshotEvents: (fromSeq = 0, toSeqExclusive = log.length) => log.slice(fromSeq, toSeqExclusive)
	};
	const legacy = { id: "legacy-session", events: [usageEvent(1, 4)] };
	const opaque = { id: "opaque-session" }; // neither API shape
	const sessions = { list: () => [modern, legacy, opaque] };
	const ctx = makeContext({ sessions, persistence: {} });
	const result = await plugin.collectUsage(ctx);
	assert.equal(result.total.tokens, 15, "modern + legacy sessions must both fold; an opaque session must be skipped");

	// Appending to the modern log must fold incrementally, not refold.
	log.push(usageEvent(3, 9));
	modern.seq = log.length;
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 24, "the modern session's appended events must be folded");

	// A persistence backend exposing neither listSnapshots() nor list() must
	// not fail the route, must not prune the cached folds it cannot enumerate,
	// and must say so (`partial`) instead of reporting a total of 0.
	const bare = makeContext({ sessions: { list: () => [] }, persistence: {} });
	const bareResult = await plugin.collectUsage(bare);
	assert.equal(bareResult.total.tokens, 24, "an unknown persistence surface must keep the cached persisted usage");
	assert.equal(bareResult.partial, true, "an unlistable persistence surface must flag the payload as incomplete");
}

/**
 * Persistence API drift: dsh 0.1.2 dropped `listSnapshots()` and
 * `readFrom()`. `list()` now returns snapshots (`{ header, revision }`) and
 * events are read through `open(id, "read")` + `handle.read(offset)`. A
 * regression here silently hides all historical usage from the panel, so the
 * modern shape is covered explicitly.
 */
async function testPersistedApiDrift(root) {
	const plugin = await freshModule("persisted-drift", join(root, "persisted-drift"));
	const id = "modern-persisted";
	const log = [usageEvent(1, 5), usageEvent(2, 6)];
	let closed = 0;
	let offsetSeen = null;
	const handle = {
		id,
		header: { id },
		access: "read",
		read: async (offset = 0) => {
			offsetSeen = offset;
			return { events: log.slice(offset), eventState: "shared" };
		},
		close: async () => { closed += 1; }
	};
	let revision = "rev-1";
	const persistence = {
		list: async () => [{ header: { id }, revision, sizeBytes: 128 }],
		open: async (openedId, access) => {
			assert.equal(openedId, id);
			assert.equal(access, "read");
			return handle;
		}
	};
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 11, "list()+open()/read() must fold persisted sessions");
	assert.equal(offsetSeen, 0, "the first fold must read from seq 0");
	assert.equal(closed, 1, "the read handle must be closed");
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 11, "an unchanged revision must skip the re-read");
	assert.equal(closed, 1);

	revision = "rev-2";
	log.push(usageEvent(3, 9));
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 20, "a new revision must fold only the appended tail");
	assert.equal(offsetSeen, 2, "the incremental read must start at the last folded seq");
	assert.equal(closed, 2);
}

/**
 * The rendered usage snapshot is reused inside one polling window, so the panel's
 * first-open fan-out (usage + account + three platform calls) and a second browser
 * tab cannot stack full folds. `refresh=1` — what the panel's ↻ button sends — must
 * bypass the reuse so a manual refresh still recomputes.
 */
async function testUsageSnapshotReuse(root) {
	const plugin = await freshModule("snapshot", join(root, "snapshot"));
	let lists = 0;
	const persistence = { list: async () => { lists += 1; return []; } };
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });

	const first = await plugin.readUsageSnapshot(ctx);
	assert.equal(lists, 1, "the first read must fold");
	const second = await plugin.readUsageSnapshot(ctx);
	assert.equal(lists, 1, "a second read inside the TTL window must reuse the snapshot");
	assert.equal(second, first, "the reused snapshot must be the same object");

	await plugin.readUsageSnapshot(ctx, true);
	assert.equal(lists, 2, "force must bypass the snapshot cache");

	const routes = new Map();
	await plugin.apply(makeContext({ sessions: { list: () => [] }, persistence, routes }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.USAGE_PATH);
	const request = (url) => ({ method: "GET", url, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } });

	const cached = makeResponse();
	await handler(request(plugin.USAGE_PATH), cached);
	assert.equal(cached.status, 200);
	assert.equal(lists, 2, "a route read inside the window must not fold again");

	const forced = makeResponse();
	await handler(request(`${plugin.USAGE_PATH}?refresh=1`), forced);
	assert.equal(forced.status, 200);
	assert.equal(lists, 3, "?refresh=1 must bypass the snapshot cache");
	assert.equal(JSON.parse(forced.body).ok, true);
}

/**
 * Stale-while-revalidate: folding a large DSH_HOME measured ~40s, so a restarted
 * host (empty in-memory snapshot) must answer the panel's first open from the
 * persisted snapshot immediately — flagged `stale` — and recompute in the
 * background. Only `refresh=1` (the ↻ button) waits for a fresh fold.
 */
async function testUsageSnapshotStaleWhileRevalidate(root) {
	const home = join(root, "swr");
	const plugin = await freshModule("swr-first", home);
	let lists = 0;
	const persistence = { list: async () => { lists += 1; return []; } };
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });

	const cold = await plugin.readUsageSnapshot(ctx);
	assert.equal(lists, 1, "the first read folds");
	assert.equal(cold.stale, undefined, "a synchronous fold is not stale");

	// A new module instance with the same DSH_HOME models a restarted host.
	const restarted = await freshModule("swr-restarted", home);
	const warm = await restarted.readUsageSnapshot(ctx);
	assert.equal(warm.stale, true, "the persisted snapshot must be served immediately, flagged stale");
	assert.equal(warm.days.length, cold.days.length, "the stale payload must carry the persisted data");
	assert.equal(lists, 1, "serving the persisted snapshot must not fold");

	const pending = restarted.pendingUsageRefresh();
	assert.notEqual(pending, null, "a background refresh must have been started");
	await pending;
	assert.equal(lists, 2, "the background refresh folds once");

	const fresh = await restarted.readUsageSnapshot(ctx);
	assert.equal(fresh.stale, undefined, "the background fold must leave a fresh snapshot behind");
	assert.equal(lists, 2, "the fresh snapshot is reused inside the TTL window");

	const forced = await restarted.readUsageSnapshot(ctx, true);
	assert.equal(forced.stale, undefined, "force never returns a stale payload");
	assert.equal(lists, 3, "force folds again");
}

/**
 * Report repro 4: a failed `persistence.list()` used to look like "no sessions",
 * so the prune deleted every cached fold, the cache file was rewritten without
 * them and the route answered 0 as if that were a real total. A failure must
 * keep the cached folds, skip the prune and flag the payload `partial`.
 */
async function testPersistedListingFailure(root) {
	const home = join(root, "listing-failure");
	const plugin = await freshModule("listing-failure", home);
	const id = "listing-session";
	let mode = "ok"; // ok | boom | empty
	const persistence = {
		list: async () => {
			if (mode === "boom") throw new Error("storage unavailable");
			return mode === "empty" ? [] : [{ header: { id }, revision: "r1" }];
		},
		readFrom: async () => ({ events: [usageEvent(1, 100)] })
	};
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 100);

	// Transient listing failure: the cached fold survives and says so.
	mode = "boom";
	const partial = await plugin.collectUsage(ctx);
	assert.equal(partial.total.tokens, 100, "a failed listing must not delete the cached fold");
	assert.equal(partial.partial, true, "a failed listing must be reported as incomplete");

	const cacheFile = JSON.parse(await readFile(join(home, "storages", "usage-stats-cache.json"), "utf8"));
	assert.ok(cacheFile.sessions[id] !== void 0, "the session must stay in the cache file after a failed listing");

	// A SUCCESSFUL listing without that session is the only reason to prune.
	mode = "empty";
	const pruned = await plugin.collectUsage(ctx);
	assert.equal(pruned.partial, void 0, "a complete listing is a complete listing");
	assert.equal(pruned.failedSessions, void 0, "no read failures means no failure counter");
	assert.equal(pruned.total.tokens, 0, "a session missing from a successful listing must be pruned");
}

/**
 * Report repro 7: the listing succeeded but the only session could not be read.
 * The fold used to answer 0 tokens (or last run's number) behind a warning log,
 * so an unreadable/corrupt session looked like "no usage at all".
 */
async function testPersistedReadFailure(root) {
	const home = join(root, "read-failure");
	const plugin = await freshModule("read-failure", home);
	const id = "unreadable-session";
	let readFails = false;
	const persistence = {
		list: async () => [{ header: { id }, revision: readFails ? "r2" : "r1" }],
		readFrom: async (sessionId, fromSeq) => {
			if (readFails) throw new Error("EACCES: session log unreadable");
			return { events: [usageEvent(1, 100)].filter((event) => event.seq > fromSeq) };
		}
	};
	const ctx = makeContext({ sessions: { list: () => [] }, persistence });
	assert.equal((await plugin.collectUsage(ctx)).total.tokens, 100);

	// Same session, now unreadable: keep the cached fold, but say the result is partial.
	readFails = true;
	const broken = await plugin.collectUsage(ctx);
	assert.equal(broken.total.tokens, 100, "the cached fold must be kept, not zeroed");
	assert.equal(broken.partial, true, "an unreadable session makes the payload incomplete");
	assert.equal(broken.failedSessions, 1, "the payload must count the failed sessions");

	// Cold start with the same failure: 0 tokens is correct data, but never "complete".
	const coldHome = join(root, "read-failure-cold");
	const cold = await freshModule("read-failure-cold", coldHome);
	const coldCtx = makeContext({ sessions: { list: () => [] }, persistence });
	const coldResult = await cold.collectUsage(coldCtx);
	assert.equal(coldResult.total.tokens, 0);
	assert.equal(coldResult.partial, true, "empty because unreadable is not the same as empty");
	assert.equal(coldResult.failedSessions, 1);
}

async function testSessionCostRoute(root) {
	const home = join(root, "session-cost");
	const plugin = await freshModule("sessioncost", home);
	const beijing = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour, minute) - 8 * 3600 * 1000;
	const usageEventAt = (seq, tokens, time, turn) => ({
		seq,
		type: "assistant/message",
		time,
		data: {
			turn,
			step: 0,
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: tokens, cacheWriteTokens: 0 },
			message: { source: { model: "deepseek-flash" } }
		}
	});
	// Oct 18 02:00 / 02:30 are both off-peak (Sunday / outside peak windows), so
	// 1M + 2M cache-hit tokens cost 0.02 + 0.04 CNY; the child session was created
	// at 02:31, i.e. during turn 2, so its 0.02 CNY belongs to turn 2.
	const mainEvents = [
		usageEventAt(1, 1000000, beijing(2026, 10, 18, 2, 0), 1),
		usageEventAt(2, 2000000, beijing(2026, 10, 18, 2, 30), 2)
	];
	const childEvents = [usageEventAt(1, 1000000, beijing(2026, 10, 18, 2, 31), 1)];
	const sessions = [{ id: "session-main", header: { id: "session-main", delegationDepth: 0 }, events: mainEvents }];
	const persistence = {
		listSnapshots: async () => [{ header: { id: "session-child", parentSession: "session-main", origin: "subagent", delegationDepth: 1, createdAt: beijing(2026, 10, 18, 2, 31) }, revision: 7 }],
		readFrom: async (id, fromSeq) => ({ events: id === "session-child" ? childEvents.filter((event) => event.seq >= fromSeq) : [] })
	};
	const routes = new Map();
	await plugin.apply(makeContext({ sessions: { list: () => sessions }, persistence, routes }), {}, { disableBackgroundRefresh: true });
	const handler = routes.get(plugin.SESSION_COST_PATH);
	assert.equal(typeof handler, "function", "the session cost route must be registered");
	const request = (sessionId) => ({ method: "GET", url: `${plugin.SESSION_COST_PATH}?sessionId=${sessionId}`, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } });

	const response = makeResponse();
	await handler(request("session-main"), response);
	assert.equal(response.status, 200);
	const payload = JSON.parse(response.body);
	assert.equal(payload.ok, true);
	assert.equal(payload.total.tokens, 4000000);
	assert.equal(payload.total.cacheHitRate, 100);
	assert.equal(payload.main.cost, 0.06);
	assert.equal(payload.subagents.count, 1, "the subagent child session must be included");
	assert.equal(payload.subagents.cost, 0.02);
	assert.equal(payload.subagents.tokens, 1000000);
	assert.equal(payload.total.cost, 0.08);
	assert.equal(payload.total.idleTokens, 4000000);
	// Per-turn rows drive the "本轮用量" dialog: turn 2 owns the child session cost.
	assert.equal(payload.turns.length, 2);
	assert.equal(payload.turns[0].turn, 1);
	assert.equal(payload.turns[0].totalCost, 0.02);
	assert.equal(payload.turns[0].subagentSessions, 0);
	assert.equal(payload.turns[1].turn, 2);
	assert.equal(payload.turns[1].mainCost, 0.04);
	assert.equal(payload.turns[1].subagentSessions, 1);
	assert.equal(payload.turns[1].subagentCost, 0.02);
	assert.equal(payload.turns[1].totalCost, 0.06);

	// Unknown / empty ids and foreign callers are refused before any fold.
	const missing = makeResponse();
	await handler(request("session-nope"), missing);
	assert.equal(missing.status, 404);
	const invalid = makeResponse();
	await handler({ method: "GET", url: plugin.SESSION_COST_PATH, headers: { host: "localhost:3080" }, socket: { remoteAddress: "127.0.0.1" } }, invalid);
	assert.equal(invalid.status, 400);
	const foreign = makeResponse();
	await handler({ ...request("session-main"), socket: { remoteAddress: "203.0.113.7" } }, foreign);
	assert.equal(foreign.status, 403);

	// A second poll must serve the cached (incremental) fold: same numbers.
	const second = makeResponse();
	await handler(request("session-main"), second);
	assert.equal(JSON.parse(second.body).total.cost, 0.08);
}

const root = await mkdtemp(join(tmpdir(), "dsh-usage-stats-"));
try {
	await testRouteFence(root);
	await testConfigValidation(root);
	await testSessionCostRoute(root);
	await testBackgroundRefresh(root);
	await testPersistedToLive(root);
	await testRevisionRewrite(root);
	await testLiveSessionApiDrift(root);
	await testPersistedApiDrift(root);
	await testUsageSnapshotReuse(root);
	await testUsageSnapshotStaleWhileRevalidate(root);
	await testPersistedListingFailure(root);
	await testPersistedReadFailure(root);
	console.log("SERVER REGRESSION TESTS PASSED");
} finally {
	delete process.env.DSH_HOME;
	await rm(root, { recursive: true, force: true });
}
