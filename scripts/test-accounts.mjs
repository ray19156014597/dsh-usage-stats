import assert from "node:assert/strict";
import {
	ACCOUNT_REFRESH_MS,
	assertTargetPolicy,
	createAccountService,
	isPrivateAddress,
	isProxyPlaceholderAddress,
	queryAccount,
	validateAccountConfig
} from "../lib/accounts.js";

/** Credential seam stub: resolves exactly the refs present in `values`. */
function credentials(values) {
	return {
		resolve: async (ref) => Object.hasOwn(values, ref) ? { value: values[ref] } : void 0
	};
}

/** One DeepSeek `/user/balance` body (strings, as the live API returns them). */
function deepseekBody(overrides = {}) {
	return {
		is_available: true,
		balance_infos: [{
			currency: "CNY",
			total_balance: "36.44",
			granted_balance: "16.44",
			topped_up_balance: "20.00"
		}],
		...overrides
	};
}

function jsonResponse(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" }
	});
}

const NOW = Date.parse("2026-08-15T00:00:00Z");
const KEY = "sk-deepseek-test";

/** Fetch stub that records every call and answers from a value or a factory. */
function recordingFetch(answer) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return typeof answer === "function" ? answer(calls.length) : answer;
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

function deps(fetchImpl, extra = {}) {
	return { fetch: fetchImpl, now: () => NOW, ...extra };
}

//#region transport policy

assert.equal(isPrivateAddress("127.0.0.1"), true);
assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
assert.equal(isPrivateAddress("::ffff:7f00:1"), true);
assert.equal(isPrivateAddress("fc00::1"), true);
assert.equal(isPrivateAddress("fe80::1"), true);
assert.equal(isPrivateAddress("fec0::1"), true);
assert.equal(isPrivateAddress("100::1"), true);
assert.equal(isPrivateAddress("2001:2::1"), true);
assert.equal(isPrivateAddress("2002:7f00:1::"), true);
assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
assert.equal(isPrivateAddress("api.deepseek.com"), false, "a hostname is not an address");
console.log("IPv4/IPv6 private-address classification ok");

// The local-proxy fake-ip range stays classified as non-public (it is not
// routable), but it is recognised separately so a hostname answered with a
// placeholder is not mistaken for an SSRF target.
assert.equal(isPrivateAddress("198.18.0.5"), true, "a fake-ip placeholder is still not a public address");
assert.equal(isProxyPlaceholderAddress("198.18.0.5"), true);
assert.equal(isProxyPlaceholderAddress("198.19.255.254"), true);
assert.equal(isProxyPlaceholderAddress("198.20.0.1"), false, "the allowance must stop at 198.18.0.0/15");
assert.equal(isProxyPlaceholderAddress("198.17.255.255"), false);
assert.equal(isProxyPlaceholderAddress("10.0.0.7"), false);
assert.equal(isProxyPlaceholderAddress("::ffff:198.18.0.5"), true, "the IPv4-mapped form must classify identically");
assert.equal(isProxyPlaceholderAddress("::ffff:198.20.0.5"), false);
assert.equal(isProxyPlaceholderAddress("2606:4700:4700::1111"), false);
assert.equal(isProxyPlaceholderAddress("api.deepseek.com"), false);
console.log("local-proxy fake-ip placeholder classification ok");

//#endregion

//#region config

assert.deepEqual(validateAccountConfig(), {});
assert.deepEqual(validateAccountConfig({ usageTokenRef: "DEEPSEEK_USAGE_TOKEN" }), { usageTokenRef: "DEEPSEEK_USAGE_TOKEN" });
assert.deepEqual(validateAccountConfig({ usageTokenRef: "  DEEPSEEK_USAGE_TOKEN  " }), { usageTokenRef: "DEEPSEEK_USAGE_TOKEN" });
assert.deepEqual(validateAccountConfig({ monitors: { relay: { adapter: "general" } } }), {}, "the multi-provider config shape must be ignored, not honoured");
assert.throws(() => validateAccountConfig({ usageTokenRef: "" }), /usageTokenRef must be a non-empty credential reference/);
assert.throws(() => validateAccountConfig({ usageTokenRef: 5 }), /usageTokenRef must be a non-empty credential reference/);
assert.throws(() => validateAccountConfig(null), /account config must be an object/);
assert.throws(() => validateAccountConfig([]), /account config must be an object/);
console.log("DeepSeek-only config validation ok");

//#endregion

//#region balance query

{
	const fetchImpl = recordingFetch(jsonResponse(deepseekBody()));
	const account = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), deps(fetchImpl));
	assert.equal(account.id, "deepseek-official");
	assert.equal(account.displayName, "DeepSeek");
	assert.equal(account.mode, "balance");
	assert.equal(account.status, "ok");
	assert.equal(account.fetchedAt, NOW);
	assert.equal(account.balance.remaining, 36.44);
	assert.equal(account.balance.currency, "CNY");
	assert.equal(account.balance.available, true);
	assert.deepEqual(account.balance.breakdown, { granted: 16.44, toppedUp: 20 });
	assert.equal(fetchImpl.calls.length, 1, "exactly one balance request");
	assert.equal(fetchImpl.calls[0].url, "https://api.deepseek.com/user/balance");
	assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${KEY}`);
	assert.equal(JSON.stringify(account).includes(KEY), false, "the snapshot must never contain the credential");
	console.log("DeepSeek balance normalization ok");
}

{
	// The base URL and credential ref come from the harness `llm-deepseek`
	// settings namespace, so both must be overridable.
	const fetchImpl = recordingFetch(jsonResponse(deepseekBody()));
	const account = await queryAccount(credentials({ MY_DS_KEY: KEY }), deps(fetchImpl, {
		apiKeyRef: "MY_DS_KEY",
		baseURL: "https://relay.example.com/v1"
	}));
	assert.equal(account.status, "ok");
	assert.equal(fetchImpl.calls[0].url, "https://relay.example.com/user/balance", "the DeepSeek balance path is absolute");
	assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${KEY}`);
	console.log("apiKeyRef/baseURL override ok");
}

{
	const account = await queryAccount(credentials({}), deps(recordingFetch(jsonResponse(deepseekBody()))));
	assert.equal(account.status, "not-configured");
	assert.equal(account.balance, null);
	assert.deepEqual(account.missingCredentials, ["DEEPSEEK_API_KEY"]);
	console.log("missing credential classification ok");
}

{
	// `is_available: false` is an upstream account state: the amount is still
	// reported and must survive normalization.
	const account = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), deps(recordingFetch(jsonResponse(deepseekBody({ is_available: false })))));
	assert.equal(account.status, "unavailable");
	assert.equal(account.balance.remaining, 36.44, "a reported zero/unavailable balance must still carry its amount");
	console.log("provider-reported unavailable state ok");
}

{
	const cases = [
		[401, "unauthorized"],
		[403, "unauthorized"],
		[429, "rate-limited"],
		[500, "unavailable"],
		[503, "unavailable"]
	];
	for (const [status, expected] of cases) {
		const account = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), deps(recordingFetch(jsonResponse({ error: "nope" }, status))));
		assert.equal(account.status, expected, `HTTP ${status} must map to ${expected}`);
		assert.equal(account.balance, null);
	}
	const invalidJson = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), deps(recordingFetch(new Response("not json", { status: 200 }))));
	assert.equal(invalidJson.status, "invalid-response");
	const noAmount = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), deps(recordingFetch(jsonResponse({ is_available: true, balance_infos: [] }))));
	assert.equal(noAmount.status, "invalid-response", "a body without a numeric amount is not a valid balance");
	console.log("HTTP/status failure mapping ok");
}

{
	// Without an injected `fetch` the real pinned transport runs. Every policy
	// rejection must happen before a connection is attempted.
	const noFetch = { now: () => NOW };
	const insecure = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), { ...noFetch, baseURL: "http://127.0.0.1:9" });
	assert.equal(insecure.status, "unsupported", "a non-HTTPS base URL must be refused");
	assert.equal(insecure.balance, null);

	const literalPrivate = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), { ...noFetch, baseURL: "https://127.0.0.1" });
	assert.equal(literalPrivate.status, "unsupported", "a literal private address must be refused");

	const dnsPrivate = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), {
		...noFetch,
		lookup: async () => [{ address: "10.0.0.7", family: 4 }]
	});
	// Environment condition, not a configuration error: `unavailable` is
	// transient, so a previously fetched balance is retained and the card
	// reports the address instead of blanking out.
	assert.equal(dnsPrivate.status, "unavailable", "a hostname resolving to a private address must not be queried");
	assert.equal(dnsPrivate.policyReason, "private-network");
	assert.equal(dnsPrivate.resolvedAddress, "10.0.0.7");
	assert.equal(dnsPrivate.balance, null);

	const credentialsInUrl = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), { ...noFetch, baseURL: "https://user:pass@api.deepseek.com" });
	assert.equal(credentialsInUrl.status, "unsupported", "a URL carrying credentials must be refused");
	assert.equal(credentialsInUrl.policyReason, "credentials-in-url");
	console.log("pinned-transport policy rejections ok");
}

{
	// Local-proxy fake-ip DNS (Clash/Mihomo/Surge/iKuuu style) answers every
	// query with 198.18.0.0/15 and routes by SNI. Refusing it made the balance
	// appear and disappear with the VPN state, so the placeholder must be
	// accepted and pinned like a normal validated answer.
	const target = await assertTargetPolicy("https://api.deepseek.com/user/balance", {
		lookup: async () => [{ address: "198.18.0.5", family: 4 }]
	});
	assert.equal(target.address, "198.18.0.5", "a fake-ip answer must be pinned, not rejected");
	assert.equal(target.url.hostname, "api.deepseek.com");

	const requested = [];
	await assertTargetPolicy("https://api.deepseek.com/user/balance", {
		lookup: async (hostname, options) => {
			requested.push([hostname, options]);
			return [{ address: "198.18.0.5", family: 4 }];
		}
	});
	assert.deepEqual(requested, [["api.deepseek.com", { all: true, verbatim: true }]]);

	const mixed = await assertTargetPolicy("https://api.deepseek.com/user/balance", {
		lookup: async () => [{ address: "198.18.0.5", family: 4 }, { address: "10.0.0.7", family: 4 }]
	}).then(() => "accepted", (error) => error.providerStatus);
	assert.equal(mixed, "unavailable", "a genuine private address in the same answer must still be refused");

	const literalPlaceholder = await assertTargetPolicy("https://198.18.0.5/user/balance", {})
		.then(() => "accepted", (error) => error.policyReason);
	assert.equal(literalPlaceholder, "private-host", "a literal fake-ip address in the configuration stays refused");
	console.log("local-proxy fake-ip answers accepted and pinned ok");
}

//#endregion

//#region account service

assert.equal(ACCOUNT_REFRESH_MS, 300000);

{
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return jsonResponse(deepseekBody()); };
	const service = await createAccountService({ credentials: credentials({ DEEPSEEK_API_KEY: KEY }), deps: deps(fetchImpl) });
	await service.validate();
	assert.equal(await service.get("zai"), null, "only DeepSeek ids are served");
	assert.equal((await service.get("deepseek")).status, "ok", "the legacy deepseek id is served too");

	const first = await service.get("deepseek-official");
	assert.equal(first.status, "ok");
	assert.equal(calls, 1);
	assert.equal(await service.get("deepseek-official"), first, "a fresh cache hit must reuse the snapshot");
	assert.equal(calls, 1);

	const [a, b] = await Promise.all([
		service.get("deepseek-official", { force: true }),
		service.get("deepseek-official", { force: true })
	]);
	assert.equal(a, b, "concurrent forced refreshes must share one single-flight request");
	assert.equal(calls, 2);

	assert.equal((await service.get("deepseek-official", { force: true })).status, "ok");
	assert.equal(calls, 3);
	assert.deepEqual((await service.refreshAll()).map((entry) => entry.status), ["ok"]);
	assert.equal(calls, 4);
	console.log("account cache and single-flight contract ok");
}

{
	let clock = NOW;
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return jsonResponse(deepseekBody()); };
	const service = await createAccountService({
		credentials: credentials({ DEEPSEEK_API_KEY: KEY }),
		deps: { fetch: fetchImpl, now: () => clock }
	});
	await service.get("deepseek-official");
	assert.equal(calls, 1);
	clock = NOW + ACCOUNT_REFRESH_MS - 1;
	await service.get("deepseek-official");
	assert.equal(calls, 1, "within the TTL the cache must be reused");
	clock = NOW + ACCOUNT_REFRESH_MS;
	await service.get("deepseek-official");
	assert.equal(calls, 2, "past the TTL the account must be refetched");
	console.log("account cache TTL ok");
}

{
	let answer = () => jsonResponse(deepseekBody());
	const fetchImpl = async () => answer();
	const service = await createAccountService({ credentials: credentials({ DEEPSEEK_API_KEY: KEY }), deps: deps(fetchImpl) });
	const ok = await service.get("deepseek-official");
	assert.equal(ok.status, "ok");
	answer = () => jsonResponse({ error: "boom" }, 500);
	const stale = await service.get("deepseek-official", { force: true });
	assert.equal(stale.status, "unavailable");
	assert.equal(stale.stale, true, "a transient failure must retain the previous snapshot");
	assert.equal(stale.balance.remaining, ok.balance.remaining);
	assert.equal(stale.lastSuccessAt, NOW);
	assert.equal(service.cached("deepseek-official").balance.remaining, ok.balance.remaining);

	// Report repro 7: a SECOND consecutive transient failure used to drop the
	// balance, because the fallback read the cache entry (which is already the
	// failure) instead of the last successful snapshot.
	const staleAgain = await service.get("deepseek-official", { force: true });
	assert.equal(staleAgain.status, "unavailable");
	assert.equal(staleAgain.stale, true, "repeated transient failures must keep serving the last success");
	assert.equal(staleAgain.balance?.remaining, ok.balance.remaining, "the balance must survive repeated outages");
	assert.equal(staleAgain.lastSuccessAt, NOW, "lastSuccessAt must stay the real success time");

	// A third outage, then recovery: the fresh snapshot replaces the stale one.
	await service.get("deepseek-official", { force: true });
	answer = () => jsonResponse(deepseekBody({
		balance_infos: [{ currency: "CNY", total_balance: "12.50", granted_balance: "0", topped_up_balance: "12.50" }]
	}));
	const recovered = await service.get("deepseek-official", { force: true });
	assert.equal(recovered.status, "ok");
	assert.equal(recovered.stale, void 0, "a successful fetch must clear the stale flag");
	assert.equal(recovered.balance.remaining, 12.5);
	console.log("transient stale retention ok (repeated outages keep the last success)");
}

{
	const service = await createAccountService({ credentials: credentials({}), deps: deps(recordingFetch(jsonResponse(deepseekBody()))) });
	const missing = await service.get("deepseek-official");
	assert.equal(missing.status, "not-configured");
	assert.equal(missing.stale, void 0, "not-configured is a config state, not a transient failure");
	assert.equal(service.cached("zai"), null);
	console.log("not-configured is not cached as stale ok");
}

//#endregion

//#region pinned transport over a real socket

{
	const { createServer } = await import("node:http");
	const localDeps = (port, extra = {}) => ({
		now: () => NOW,
		baseURL: `http://127.0.0.1:${port}`,
		allowInsecure: true,
		allowPrivateNetwork: true,
		timeoutMs: 5000,
		...extra
	});

	// Headers arrive, then the socket dies mid-body. This used to leave the
	// Promise unsettled forever, which wedged the whole refresh cycle.
	const abortServer = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
		res.write('{"is_available":true,');
		setTimeout(() => res.socket.destroy(), 20);
	});
	const abortPort = await new Promise((resolve) => abortServer.listen(0, "127.0.0.1", () => resolve(abortServer.address().port)));
	try {
		const account = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), localDeps(abortPort));
		assert.equal(account.status, "unavailable", "a mid-body reset must settle instead of hanging");
	} finally {
		abortServer.close();
	}

	// A body above maxResponseBytes must be rejected without crashing the
	// process (`request.destroy(error)` used to re-emit the error unhandled).
	const bigServer = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(deepseekBody()).padEnd(4096, " "));
	});
	const bigPort = await new Promise((resolve) => bigServer.listen(0, "127.0.0.1", () => resolve(bigServer.address().port)));
	try {
		const account = await queryAccount(credentials({ DEEPSEEK_API_KEY: KEY }), localDeps(bigPort, { maxResponseBytes: 256 }));
		assert.equal(account.status, "invalid-response", "an oversized body must be rejected, not crash the process");
	} finally {
		bigServer.close();
	}
	console.log("pinned transport settles on mid-body reset and size cap ok");
}

//#endregion

console.log("ACCOUNT TESTS PASSED");
