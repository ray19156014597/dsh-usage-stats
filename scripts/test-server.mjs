import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
	assert.equal(routes.size, 7, "the DeepSeek-only plugin must register exactly seven routes");
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
	// be skipped without failing the route.
	const bare = makeContext({ sessions: { list: () => [] }, persistence: {} });
	const bareResult = await plugin.collectUsage(bare);
	assert.equal(bareResult.total.tokens, 0, "an unknown persistence surface must degrade to no persisted usage");
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

const root = await mkdtemp(join(tmpdir(), "dsh-usage-stats-"));
try {
	await testRouteFence(root);
	await testConfigValidation(root);
	await testBackgroundRefresh(root);
	await testPersistedToLive(root);
	await testRevisionRewrite(root);
	await testLiveSessionApiDrift(root);
	await testPersistedApiDrift(root);
	await testUsageSnapshotReuse(root);
	await testUsageSnapshotStaleWhileRevalidate(root);
	console.log("SERVER REGRESSION TESTS PASSED");
} finally {
	delete process.env.DSH_HOME;
	await rm(root, { recursive: true, force: true });
}
