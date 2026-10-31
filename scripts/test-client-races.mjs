/**
 * Client race / freshness contract (no DOM harness).
 *
 * The panel bundle is rendered with react-dom/server in `smoke-client.mjs`, which
 * runs no effects and no async work — so it cannot exercise "a stale response lands
 * after the credential changed" or "a failure note renders on the card". Those
 * contracts are asserted here against the bundle source: each assertion pins an
 * exact expression that the implementation must keep.
 *
 * Report F02: clearing/switching a token only invalidated the day detail; monthly,
 * recent-14-day and cumulative requests could still land and write the previous
 * account's numbers back into state.
 * Report F03: the platform failure lived only inside the collapsed section and the
 * global "updated at" timestamp was refreshed by the local usage poll.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** Body of `const NAME = react.useCallback(` … through the matching `}, [...])`. */
function callbackBody(name) {
	const start = source.indexOf(`const ${name} = react.useCallback(`);
	assert.ok(start >= 0, `${name} must exist`);
	const end = source.indexOf("\n\t\t\t}, [", start);
	assert.ok(end > start, `${name} must close with a dependency array`);
	return source.slice(start, end);
}

const loadPlatform = callbackBody("loadPlatform");
const loadPlatformTotal = callbackBody("loadPlatformTotal");
const loadRecentPlatform = callbackBody("loadRecentPlatform");
const loadDayDetail = callbackBody("loadDayDetail");
const saveToken = callbackBody("saveToken");
const clearToken = callbackBody("clearToken");

// ── F02: every account-scoped load carries a credential generation ────────────
for (const [name, body] of [["loadPlatform", loadPlatform], ["loadPlatformTotal", loadPlatformTotal], ["loadRecentPlatform", loadRecentPlatform], ["loadDayDetail", loadDayDetail]]) {
	assert.ok(/const gen = credentialGenRef\.current;/.test(body), `${name} must capture the credential generation`);
	assert.ok(/credentialGenRef\.current !== gen/.test(body), `${name} must drop results from a stale generation`);
}
// The cumulative walk needs its own request sequence on top of the generation.
assert.ok(/const seq = \+\+totalSeqRef\.current;/.test(loadPlatformTotal), "loadPlatformTotal must own a request sequence");
assert.ok(/totalSeqRef\.current !== seq/.test(loadPlatformTotal), "loadPlatformTotal must drop out-of-order responses");

// Both "change account" paths bump the generation and clear the old numbers.
for (const [name, body] of [["saveToken", saveToken], ["clearToken", clearToken]]) {
	assert.ok(/credentialGenRef\.current \+= 1;/.test(body), `${name} must invalidate in-flight responses`);
	assert.ok(/setPlatformTotal\(null\)/.test(body), `${name} must clear the cached total`);
	assert.ok(/setRecentPlat\(null\)/.test(body), `${name} must clear the recent-14-day cache`);
	assert.ok(/dayDetailSeqRef\.current \+= 1/.test(body), `${name} must invalidate the day detail`);
}
// The web-login capture path is a credential switch too.
assert.ok(
	/setTokenMessage\(translate\("token\.syncCaptured"\)\)/.test(source),
	"the sync capture path must still report success"
);
const syncCapture = source.slice(source.indexOf('if (statusPayload.last?.ok === true) {'), source.indexOf('setTokenMessage(translate("token.syncCaptured"))'));
assert.ok(/credentialGenRef\.current \+= 1;/.test(syncCapture), "a captured token must bump the generation before reloading");

// ── F03: platform state is not cleared at request start ───────────────────────
const platformStartToFetch = loadPlatform.slice(
	loadPlatform.indexOf("platformLoaderRef.current.start()"),
	loadPlatform.indexOf("fetchJson(")
);
assert.ok(
	!/setPlatformError\(null\)/.test(platformStartToFetch),
	"loadPlatform must not clear the failure state before the request settles (a cached reload would erase it)"
);
assert.ok(/setPlatformError\(null\);/.test(loadPlatform), "a successful platform response must clear the failure state");
assert.ok(/setPlatformOkAt\(payload\.fetchedAt/.test(loadPlatform), "a successful platform response must record its own timestamp");

// ── F08: the settings messages must be able to say "the ref still wins" ───────
assert.ok(/token\.clearedOverride/.test(source), "the clear message must cover the credential-ref case");
assert.ok(/token\.savedOverride/.test(source), "the save message must cover the credential-ref case");

console.log("client race + platform freshness contract ok");
