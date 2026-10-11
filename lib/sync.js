/**
 * dsh-usage-stats — web-login auto-sync for the DeepSeek platform usage token.
 *
 * Port of DeepSeekMonitorWindows' "网页登录自动同步" (Method 1) to the
 * harness host: the plugin cannot script the user's browser tab, so it opens
 * a dedicated system-browser window (Edge/Chrome) through the Chrome DevTools
 * Protocol and captures the usage token from that window.
 *
 * Flow (mirrors the WebView2 approach):
 *   1. Spawn `msedge`/`chrome` with `--remote-debugging-port=0` and a
 *      persistent profile under DSH_HOME (login survives between runs).
 *   2. Attach to the new tab, navigate to https://platform.deepseek.com.
 *   3. Inject the same fetch/XMLHttpRequest Authorization hook the desktop
 *      app uses, and poll `localStorage.userToken` — whichever fires first.
 *   4. Verify the captured token against `/api/v0/usage/amount`, save it,
 *      then close the browser window.
 *
 * No npm dependencies: the DevTools WebSocket speaks JSON-RPC over Node's
 * built-in WebSocket (Node >= 22). The browser is only opened on demand and
 * the token never leaves the server.
 *
 * @module dsh-usage-stats/sync
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_SPAWN_TIMEOUT_MS = 12000;
const PLATFORM_URL = "https://platform.deepseek.com";

/** Candidate browser executables, most-likely first (Windows-first). */
export function findBrowserPaths() {
	const paths = [];
	const pf = process.env.ProgramFiles ?? "C:\\Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const push = (parts) => paths.push(typeof parts === "string" ? parts : join(...parts));
	push([pf86, "Microsoft", "Edge", "Application", "msedge.exe"]);
	push([pf, "Microsoft", "Edge", "Application", "msedge.exe"]);
	push([pf, "Google", "Chrome", "Application", "chrome.exe"]);
	push([pf86, "Google", "Chrome", "Application", "chrome.exe"]);
	if (localAppData !== "") push([localAppData, "Google", "Chrome", "Application", "chrome.exe"]);
	if (process.platform === "darwin") {
		push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
		push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	}
	if (process.platform === "linux") {
		push("/usr/bin/microsoft-edge");
		push("/usr/bin/google-chrome");
		push("/usr/bin/google-chrome-stable");
	}
	return paths;
}

/** First existing candidate path, or null. */
export function resolveBrowserPath(candidates = findBrowserPaths()) {
	return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Spawn the browser with a fresh DevTools endpoint. Resolves with
 * `{ proc, wsUrl }` once the "DevTools listening on ws://…" line appears on
 * stderr; rejects (and kills the process) when it exits early or times out.
 */
export function spawnBrowser(browserPath, userDataDir, deps = {}) {
	const timeoutMs = deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
	const spawnImpl = deps.spawnImpl ?? spawn;
	return new Promise((resolve, reject) => {
		const proc = spawnImpl(browserPath, [
			"--remote-debugging-port=0",
			`--user-data-dir=${userDataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank"
		], { stdio: ["ignore", "ignore", "pipe"], windowsHide: false });
		let settled = false;
		let stderrBuf = "";
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};
		const timer = setTimeout(() => {
			try { proc.kill(); } catch { /* already gone */ }
			finish(reject, syncError("unavailable", "browser did not start in time"));
		}, timeoutMs);
		proc.stderr?.on("data", (chunk) => {
			stderrBuf += String(chunk);
			const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrBuf);
			if (match !== null) finish(resolve, { proc, wsUrl: match[1] });
		});
		proc.on("error", (error) => finish(reject, syncError("unavailable", `browser could not be launched: ${error.message}`)));
		proc.on("exit", (code) => finish(reject, syncError("aborted", `browser exited before starting (code ${code})`)));
	});
}

/** Error with a stable `code` for the API surface. */
export function syncError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

/**
 * Minimal CDP client over a WebSocket: pending-id map, optional sessionId
 * multiplexing, and rejection of in-flight calls when the socket closes.
 */
export class Cdp {
	constructor(wsUrl) {
		this.wsUrl = wsUrl;
		this.nextId = 1;
		this.pending = new Map();
		this.closed = false;
		this.ws = new WebSocket(wsUrl);
		this.ready = new Promise((resolve, reject) => {
			this._ready = resolve;
			this._fail = reject;
		});
		this.ws.onopen = () => this._ready();
		this.ws.onerror = () => this._fail(syncError("unavailable", "DevTools connection failed"));
		this.ws.onmessage = (event) => {
			let message;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.id === void 0) return; // events are ignored
			const entry = this.pending.get(message.id);
			if (entry === void 0) return;
			this.pending.delete(message.id);
			if (message.error !== void 0) entry.reject(syncError("unavailable", message.error.message ?? "DevTools error"));
			else entry.resolve(message.result);
		};
		this.ws.onclose = () => {
			this.closed = true;
			for (const entry of this.pending.values()) entry.reject(syncError("aborted", "login window closed"));
			this.pending.clear();
		};
	}

	async send(method, params = {}, sessionId) {
		await this.ready;
		if (this.closed) throw syncError("aborted", "login window closed");
		const id = this.nextId;
		this.nextId += 1;
		const payload = { id, method, params };
		if (sessionId !== void 0) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (error) {
				this.pending.delete(id);
				reject(syncError("unavailable", `DevTools send failed: ${error.message}`));
			}
		});
	}

	close() {
		try {
			this.ws.close();
		} catch {
			/* already closed */
		}
		this.closed = true;
	}

	get isClosed() {
		return this.closed;
	}
}

/**
 * The same Authorization-capture hook the desktop app injects into its
 * WebView: intercepts fetch/XMLHttpRequest, remembers the platform Bearer
 * token, and exposes `window.__dsm_read_token()` (with the
 * `localStorage.userToken` fallback the manual-paste flow documents).
 */
export const USAGE_TOKEN_HOOK_JS = `(() => {
	if (window.__dsm_hooked) return;
	window.__dsm_hooked = true;
	window.__dsm_read_token = () => {
		try {
			const value = JSON.parse(localStorage.userToken);
			if (value && typeof value.value === "string" && value.value.trim().length >= 20) return value.value.trim();
		} catch (e) {}
		return window.__dsm_captured || "";
	};
	const deliver = (token) => {
		if (!token || typeof token !== "string") return;
		token = token.trim();
		if (token.length < 20) return;
		if (!window.__dsm_captured) window.__dsm_captured = token;
	};
	const fromAuth = (value) => {
		if (!value) return;
		const match = /Bearer\\s+(\\S+)/i.exec(String(value));
		if (match && match[1]) deliver(match[1]);
	};
	const origFetch = window.fetch;
	if (typeof origFetch === "function") {
		window.fetch = function (input, init) {
			try {
				const headers = (init && init.headers) || (input && input.headers);
				if (headers) {
					if (typeof Headers !== "undefined" && headers instanceof Headers) fromAuth(headers.get("authorization"));
					else if (Array.isArray(headers)) { for (const entry of headers) { if (entry && String(entry[0]).toLowerCase() === "authorization") fromAuth(entry[1]); } }
					else if (typeof headers === "object") { for (const key in headers) { if (key.toLowerCase() === "authorization") fromAuth(headers[key]); } }
				}
			} catch (e) {}
			return origFetch.apply(this, arguments);
		};
	}
	const origSet = XMLHttpRequest.prototype.setRequestHeader;
	XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
		try { if (name && String(name).toLowerCase() === "authorization") fromAuth(value); } catch (e) {}
		return origSet.apply(this, arguments);
	};
})();`;

const READ_TOKEN_EXPRESSION = "window.__dsm_read_token ? window.__dsm_read_token() : ''";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive one capture session: open the platform tab, inject the hook, poll
 * both the hook and localStorage, verify the first candidate, return it.
 * Throws `syncError` with `code` "timeout" or "aborted" on failure.
 * @param deps - `{ wsUrl, verify, timeoutMs, pollMs, onStatus, signal }` where
 *   `signal` is the run's cancellation state (`{ cancelled }`); it is checked
 *   every poll so a cancel lands promptly instead of after the full timeout.
 */
export async function captureToken(deps) {
	const { wsUrl, verify } = deps;
	const signal = deps.signal ?? null;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const cdp = new Cdp(wsUrl);
	try {
		const created = await cdp.send("Target.createTarget", { url: "about:blank" });
		const targetId = created?.targetId;
		if (typeof targetId !== "string") throw syncError("unavailable", "could not create the login tab");
		const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		const sessionId = attached?.sessionId;
		if (typeof sessionId !== "string") throw syncError("unavailable", "could not attach to the login tab");
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Runtime.enable", {}, sessionId);
		await cdp.send("Page.navigate", { url: PLATFORM_URL }, sessionId);
		if (signal?.cancelled === true) throw syncError("aborted", "login sync cancelled");
		deps.onStatus?.("opened");

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (signal?.cancelled === true) throw syncError("aborted", "login sync cancelled");
			if (cdp.isClosed) throw syncError("aborted", "login window closed");
			// Re-inject idempotently so the hook survives SPA navigations.
			try {
				await cdp.send("Runtime.evaluate", { expression: USAGE_TOKEN_HOOK_JS, returnByValue: true }, sessionId);
			} catch {
				/* page not ready yet */
			}
			let candidate = "";
			try {
				const evaluated = await cdp.send("Runtime.evaluate", { expression: READ_TOKEN_EXPRESSION, returnByValue: true }, sessionId);
				candidate = evaluated?.result?.value;
			} catch {
				/* page not ready yet */
			}
			if (typeof candidate === "string" && candidate.trim().length >= 20) {
				const token = candidate.trim();
				deps.onStatus?.("captured");
				await verify(token);
				return token;
			}
			await sleep(pollMs);
		}
		throw syncError("timeout", "login sync timed out — please try again or paste the token manually");
	} finally {
		cdp.close();
	}
}

/**
 * One auto-sync service: opens a system browser, captures and verifies the
 * usage token, saves it, and closes the browser. Single-flight; the last
 * result is kept for the status endpoint. All browser mechanics are
 * injectable for tests.
 */
export function createLoginSync(options = {}) {
	const browserPaths = options.browserPaths ?? findBrowserPaths();
	const userDataDir = options.userDataDir ?? join(process.env.DSH_HOME ?? ".", "usage-stats", "browser-profile");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let current = null;
	let last = null;

	/**
	 * One run's cancellation state. It exists BEFORE the browser process does:
	 * `cancel()` used to be a no-op while `spawnBrowser()` was still pending,
	 * because the kill handle was only attached after the await, so the capture
	 * finished and the token was saved anyway.
	 */
	function killProcess(state) {
		try {
			state.proc?.kill();
		} catch {
			/* already closed */
		}
	}

	async function run(state) {
		const browserPath = resolveBrowserPath(browserPaths);
		if (browserPath === null) throw syncError("sync-unavailable", "Edge/Chrome not found — use the manual paste method instead");
		const spawned = await (options.spawn ?? spawnBrowser)(browserPath, userDataDir, options);
		state.proc = spawned.proc;
		if (state.cancelled) {
			killProcess(state);
			throw syncError("aborted", "login sync cancelled");
		}
		try {
			const token = await (options.capture ?? captureToken)({
				wsUrl: spawned.wsUrl,
				verify: options.verify,
				timeoutMs,
				pollMs: options.pollMs,
				onStatus: options.onStatus,
				signal: state
			});
			// Cancelling between the capture and the save must not store a token.
			if (state.cancelled) throw syncError("aborted", "login sync cancelled");
			await options.save(token);
			return { ok: true, captured: true };
		} finally {
			killProcess(state);
		}
	}

	async function start() {
		// A cancelled round is already over for the caller even while its capture
		// promise unwinds, so a new round may start immediately — and must not be
		// clobbered by the old round's cleanup (see `current === round` below).
		if (current !== null && current.state.cancelled !== true) return { started: true, alreadyRunning: true };
		const state = { cancelled: false, proc: null };
		const round = { state, promise: null };
		// The outcome (success or failure) is recorded in `last` and consumed
		// by the status endpoint — the rejection is swallowed here so a failed
		// sync never becomes an unhandled rejection.
		round.promise = run(state).then((result) => {
			last = { ok: true, ...result, at: Date.now() };
			return result;
		}).catch((error) => {
			const aborted = state.cancelled === true;
			const code = aborted ? "aborted" : error?.code ?? "sync-failed";
			const message = aborted ? "login sync cancelled" : error instanceof Error ? error.message : String(error);
			last = { ok: false, error: code, message, at: Date.now() };
			return { ok: false, error: code };
		}).finally(() => {
			if (current === round) current = null;
		});
		current = round;
		return { started: true, alreadyRunning: false };
	}

	/**
	 * Cancel the running round. Returns as soon as the cancellation flag is set
	 * (plus a kill when the browser already exists) instead of waiting for the
	 * capture to unwind: a cancel that arrives while `spawnBrowser()` is still
	 * pending used to be a no-op whose capture then saved the token anyway.
	 */
	async function cancel() {
		const round = current;
		if (round !== null && round.state.cancelled !== true) {
			round.state.cancelled = true;
			killProcess(round.state);
			// The round is over from the caller's point of view, so record the
			// abort now; the unwinding capture keeps reporting `aborted` too.
			last = { ok: false, error: "aborted", message: "login sync cancelled", at: Date.now() };
		}
		return { ok: true, running: false };
	}

	function running() {
		return current !== null && current.state.cancelled !== true;
	}

	async function isRunning() {
		return running();
	}

	return {
		start,
		cancel,
		isRunning,
		status: () => ({ running: running(), last })
	};
}
