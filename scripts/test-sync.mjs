// Regression tests for the web-login auto-sync module (lib/sync.js):
// browser discovery, the service lifecycle (start/cancel/status/last result),
// and the Authorization-capture hook script.
import assert from "node:assert/strict";
import { createLoginSync, findBrowserPaths, resolveBrowserPath, USAGE_TOKEN_HOOK_JS, syncError } from "../lib/sync.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

async function testBrowserDiscovery() {
	const paths = findBrowserPaths();
	assert.ok(Array.isArray(paths) && paths.length > 0, "browser candidate list must be non-empty");
	assert.ok(paths.every((path) => typeof path === "string" && path.length > 0));
	assert.equal(resolveBrowserPath([]), null, "no candidates must resolve to null");
	assert.equal(resolveBrowserPath(["C:\\missing\\browser.exe"]), null);
	assert.equal(resolveBrowserPath(["C:\\missing\\browser.exe", import.meta.filename]), import.meta.filename, "the first existing path must win");
	console.log("browser discovery ok");
}

async function testSyncSuccessFlow() {
	let saved = null;
	let killed = 0;
	const service = createLoginSync({
		// Point at a real file so resolveBrowserPath accepts it; the spawn
		// stub never actually launches it.
		browserPaths: [import.meta.filename],
		spawn: async () => ({ proc: { kill: () => { killed += 1; } }, wsUrl: "ws://127.0.0.1:1234" }),
		capture: async ({ wsUrl, verify }) => {
			assert.equal(wsUrl, "ws://127.0.0.1:1234");
			await verify("captured-token");
			return "captured-token";
		},
		verify: async (token) => { assert.equal(token, "captured-token"); },
		save: async (token) => { saved = token; }
	});
	const started = await service.start();
	assert.equal(started.started, true);
	assert.equal(started.alreadyRunning, false);
	for (let i = 0; i < 50 && await service.isRunning(); i += 1) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(saved, "captured-token", "the captured token must be saved");
	assert.equal(killed, 1, "the browser must be closed after capture");
	assert.equal(await service.isRunning(), false);
	const status = service.status();
	assert.equal(status.last.ok, true);
	console.log("sync success flow ok");
}

async function testSyncUnavailable() {
	const service = createLoginSync({
		browserPaths: [],
		spawn: async () => { throw new Error("must not spawn"); },
		verify: async () => true,
		save: async () => {}
	});
	// start() resolves immediately; the failure lands in status().last.
	const started = await service.start();
	assert.equal(started.started, true);
	for (let i = 0; i < 50 && await service.isRunning(); i += 1) await new Promise((resolve) => setImmediate(resolve));
	const status = service.status();
	assert.equal(status.last.ok, false);
	assert.equal(status.last.error, "sync-unavailable");
	assert.equal(await service.isRunning(), false);
	console.log("sync-unavailable state ok");
}

async function testSyncCancel() {
	const gate = deferred();
	let killed = 0;
	const service = createLoginSync({
		browserPaths: [import.meta.filename],
		spawn: async () => ({
			proc: { kill: () => { killed += 1; gate.reject(syncError("aborted", "login window closed")); } },
			wsUrl: "ws://127.0.0.1:1234"
		}),
		// The capture stays pending until the browser is killed — the same way
		// the DevTools socket drops when the real window is closed.
		capture: async () => gate.promise,
		verify: async () => true,
		save: async () => {}
	});
	const started = await service.start();
	assert.equal(started.started, true);
	assert.equal(await service.isRunning(), true);
	const second = await service.start();
	assert.equal(second.alreadyRunning, true, "a second start while running must be reported as already running");
	await service.cancel();
	assert.equal(await service.isRunning(), false);
	assert.ok(killed >= 1, "cancelling must kill the browser process");
	const status = service.status();
	assert.equal(status.last.ok, false, "a cancelled sync must record its abort");
	assert.equal(status.last.error, "aborted");
	console.log("sync cancel + single-flight ok");
}

async function testHookScript() {
	assert.ok(USAGE_TOKEN_HOOK_JS.includes("window.__dsm_read_token"), "hook must expose the read function");
	assert.ok(USAGE_TOKEN_HOOK_JS.includes("localStorage.userToken"), "hook must fall back to localStorage.userToken");
	assert.ok(USAGE_TOKEN_HOOK_JS.includes("authorization"), "hook must intercept the Authorization header");
	assert.ok(USAGE_TOKEN_HOOK_JS.includes("XMLHttpRequest"), "hook must wrap XHR setRequestHeader");
	console.log("usage-token hook script ok");
}

async function testSyncErrorShape() {
	const error = syncError("timeout", "boom");
	assert.equal(error.code, "timeout");
	assert.equal(error.message, "boom");
	console.log("sync error shape ok");
}

await testBrowserDiscovery();
await testSyncSuccessFlow();
await testSyncUnavailable();
await testSyncCancel();
await testHookScript();
await testSyncErrorShape();
console.log("SYNC REGRESSION TESTS PASSED");
