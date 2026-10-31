/**
 * DeepSeek account monitoring.
 *
 * The plugin is DeepSeek-only: one provider id pair, one adapter, one balance
 * endpoint. The transport pins the DNS answer the policy layer validated,
 * refuses non-public targets, caps the response body, and always settles.
 * Snapshots are secret-free: the credential is resolved at query time through
 * the credential seam and never enters the returned object.
 *
 * @module dsh-usage-stats/accounts
 */

import { balanceSchemeOf, queryBalance } from "./balance.js";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_REFRESH_MS = 300000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_IDS = new Set(["deepseek-official", "deepseek"]);
const ACCOUNT_STATUSES = new Set([
	"ok",
	"not-configured",
	"unauthorized",
	"rate-limited",
	"unavailable",
	"invalid-response",
	"unsupported"
]);
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"api-key",
	"cookie",
	"host",
	"proxy-authorization",
	"proxy-authenticate",
	"set-cookie",
	"transfer-encoding",
	"connection",
	"upgrade",
	"x-api-key"
]);
// Request credentials the balance call sets itself are allowed through; every
// other sensitive name is a connection-level header that must never come from
// a caller, because it would defeat the DNS pin (host) or corrupt the pinned
// response framing (connection/transfer-encoding/upgrade/proxy-*).
const REQUEST_CREDENTIAL_HEADERS = new Set(["authorization", "api-key", "x-api-key", "cookie"]);
const BLOCKED_REQUEST_HEADERS = new Set([...SENSITIVE_HEADERS].filter((name) => !REQUEST_CREDENTIAL_HEADERS.has(name)));

/** The single supported account: the official DeepSeek balance API. */
const DEEPSEEK_SPEC = {
	id: "deepseek-official",
	displayName: "DeepSeek",
	mode: "balance",
	adapter: "deepseek-balance"
};

function nonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberOrNull(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function round1(value) {
	return Math.round(value * 10) / 10;
}

function statusError(status, message, httpStatus, detail) {
	const error = new Error(message);
	error.providerStatus = status;
	if (httpStatus !== void 0) error.httpStatus = httpStatus;
	if (detail !== void 0) Object.assign(error, detail);
	return error;
}

/** Non-secret diagnostic detail attached to a policy rejection. */
function policyDetail(error) {
	const detail = {};
	if (nonEmptyString(error?.policyReason) !== null) detail.policyReason = error.policyReason;
	if (nonEmptyString(error?.resolvedAddress) !== null) detail.resolvedAddress = error.resolvedAddress;
	return detail;
}

function statusOf(error) {
	if (ACCOUNT_STATUSES.has(error?.providerStatus)) return error.providerStatus;
	if (error?.name === "TimeoutError" || error?.name === "AbortError") return "unavailable";
	return "unavailable";
}

async function resolveCredential(credentials, ref) {
	if (nonEmptyString(ref) === null || credentials === null || credentials === void 0 || typeof credentials.resolve !== "function") return "";
	try {
		const hit = await credentials.resolve(ref);
		return nonEmptyString(hit?.value) ?? "";
	} catch {
		return "";
	}
}

/** Validate the non-secret account configuration shape. */
export function validateAccountConfig(raw = {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("account config must be an object");
	const usageTokenRef = raw.usageTokenRef;
	if (usageTokenRef !== void 0 && (typeof usageTokenRef !== "string" || usageTokenRef.trim() === "")) {
		throw new Error("usageTokenRef must be a non-empty credential reference");
	}
	return usageTokenRef === void 0 ? {} : { usageTokenRef: usageTokenRef.trim() };
}

function ipv4Private(octets) {
	const [a, b, c] = octets;
	return a === 0
		|| a === 10
		|| a === 127
		|| a === 169 && b === 254
		|| a === 172 && b >= 16 && b <= 31
		|| a === 192 && b === 168
		|| a === 192 && b === 0 && (c === 0 || c === 2)
		|| a === 192 && b === 88 && c === 99
		|| a === 100 && b >= 64 && b <= 127
		|| a === 198 && (b === 18 || b === 19)
		|| a === 198 && b === 51 && c === 100
		|| a === 203 && b === 0 && c === 113
		|| a >= 224;
}

function ipv6Bytes(address) {
	let value = address.toLowerCase().split("%")[0];
	let ipv4Tail = null;
	const lastColon = value.lastIndexOf(":");
	if (value.slice(lastColon + 1).includes(".")) {
		const octets = value.slice(lastColon + 1).split(".").map(Number);
		if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
		ipv4Tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
		value = `${value.slice(0, lastColon)}:${ipv4Tail[0].toString(16)}:${ipv4Tail[1].toString(16)}`;
	}
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] === "" ? [] : halves[0].split(":");
	const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
	const missing = 8 - left.length - right.length;
	if (missing < 0 || halves.length === 1 && missing !== 0) return null;
	const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part || "0", 16));
	if (words.length !== 8 || words.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
	const bytes = [];
	for (const word of words) bytes.push(word >> 8, word & 0xff);
	return bytes;
}

/** True for loopback, private, link-local, documentation, multicast, and other non-public IP space. */
export function isPrivateAddress(address) {
	const value = String(address ?? "").trim().replace(/^\[|\]$/g, "");
	if (isIP(value) === 4) return ipv4Private(value.split(".").map(Number));
	if (isIP(value) !== 6) return false;
	const bytes = ipv6Bytes(value);
	if (bytes === null) return true;
	if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4Private(bytes.slice(12));
	// Public provider endpoints should resolve to global unicast (2000::/3).
	// This conservative allow-range excludes loopback/unspecified, NAT64,
	// discard-only, ULA, link/site-local, multicast, and other special space.
	const globalUnicast = (bytes[0] & 0xe0) === 0x20;
	const word0 = (bytes[0] << 8) | bytes[1];
	const word1 = (bytes[2] << 8) | bytes[3];
	// IETF protocol assignments 2001:0000::/23 include benchmarking, ORCHID,
	// and tunnel mechanisms; 2002::/16 (6to4) embeds an unchecked IPv4 target.
	const ietfSpecial = word0 === 0x2001 && word1 <= 0x01ff;
	const sixToFour = word0 === 0x2002;
	const documentation = word0 === 0x2001 && word1 === 0x0db8
		|| word0 === 0x3fff && (word1 & 0xf000) === 0;
	return !globalUnicast || ietfSpecial || sixToFour || documentation;
}

function privateHostname(hostname) {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host.endsWith(".localhost") || isPrivateAddress(host);
}

/**
 * The IPv4 quad of an IPv4 or IPv4-mapped IPv6 address (`::ffff:198.18.0.5`),
 * or null for anything else. A dual-stack resolver may answer in either form,
 * so both must be classified identically.
 */
function ipv4QuadOf(address) {
	const value = String(address ?? "").trim().replace(/^\[|\]$/g, "");
	if (isIP(value) === 4) return value;
	if (isIP(value) !== 6) return null;
	const bytes = ipv6Bytes(value);
	if (bytes === null) return null;
	const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
	return mapped ? bytes.slice(12).join(".") : null;
}

/**
 * True for a local proxy's fake-ip placeholder: Clash, Mihomo, Surge and
 * iKuuu-style tunnel clients answer every DNS query with an address inside
 * RFC 2544's benchmarking range (198.18.0.0/15) and route the connection
 * themselves, once they see the real hostname in the TLS SNI. Such an answer
 * cannot address an internal service, so it is not an SSRF concern — but it is
 * only meaningful for a *hostname*: the same address written literally in the
 * configuration stays refused, because `privateHostname` classifies it as
 * non-public.
 */
export function isProxyPlaceholderAddress(address) {
	const quad = ipv4QuadOf(address);
	if (quad === null) return false;
	const [a, b] = quad.split(".").map(Number);
	return a === 198 && (b === 18 || b === 19);
}

async function resolvePublicAddress(url, deps) {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (privateHostname(hostname) && deps.allowPrivateNetwork !== true) {
		throw statusError("unsupported", "balance target must not be a private network", void 0, { policyReason: "private-host" });
	}
	if (isIP(hostname) !== 0) return { address: hostname, family: isIP(hostname) };
	let addresses;
	try {
		addresses = await (deps.lookup ?? dnsLookup)(hostname, { all: true, verbatim: true });
	} catch {
		throw statusError("unavailable", "balance hostname could not be resolved");
	}
	if (!Array.isArray(addresses)) addresses = [addresses];
	if (addresses.length === 0) throw statusError("unavailable", "balance hostname resolved to no addresses");
	const blocked = deps.allowPrivateNetwork === true
		? []
		: addresses.filter((entry) => isPrivateAddress(entry?.address) && !isProxyPlaceholderAddress(entry?.address));
	if (blocked.length > 0) {
		// A public hostname resolving into private space is the local network's
		// doing (VPN split-DNS, hijacked resolver), not a configuration mistake,
		// so it is reported as a transient reachability failure: the card keeps
		// the last known balance and names the address instead of blanking out.
		const address = String(blocked[0]?.address ?? "");
		throw statusError("unavailable", `balance hostname resolved to a private address (${address})`, void 0, {
			policyReason: "private-network",
			resolvedAddress: address
		});
	}
	const selected = addresses[0];
	return { address: selected.address, family: selected.family ?? isIP(selected.address) };
}

/** Validate a balance target against the network policy and pin its DNS answer. */
export async function assertTargetPolicy(rawUrl, deps = {}) {
	const url = new URL(rawUrl);
	if (url.username !== "" || url.password !== "") {
		throw statusError("unsupported", "balance URL must not contain credentials", void 0, { policyReason: "credentials-in-url" });
	}
	if (url.protocol !== "https:" && deps.allowInsecure !== true) {
		throw statusError("unsupported", "balance query requires HTTPS", void 0, { policyReason: "insecure-protocol" });
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw statusError("unsupported", "balance target protocol is unsupported", void 0, { policyReason: "unsupported-protocol" });
	}
	const resolved = await resolvePublicAddress(url, deps);
	return { url, ...resolved };
}

function responseHeaders(headers) {
	return { get: (name) => {
		const value = headers[String(name).toLowerCase()];
		return Array.isArray(value) ? value.join(", ") : value === void 0 ? null : String(value);
	} };
}

function safeHeaders(headers) {
	const safe = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (typeof value === "string" && !BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) safe[name] = value;
	}
	return safe;
}

/** HTTPS/HTTP transport that pins the DNS answer checked by the policy layer. */
async function pinnedFetch(rawUrl, init, deps) {
	const target = await assertTargetPolicy(rawUrl, deps);
	const signal = init?.signal ?? AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		// The body stream can fail after the headers arrive (ECONNRESET/aborted),
		// in which case `request.on("error")` never fires. `settled` guarantees
		// exactly one outcome no matter how many of these handlers run.
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = transport(target.url, {
			method: init?.method ?? "GET",
			headers: safeHeaders(init?.headers),
			signal,
			servername: isIP(target.url.hostname.replace(/^\[|\]$/g, "")) === 0 ? target.url.hostname : void 0,
			lookup: (_hostname, options, callback) => {
				if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
				else callback(null, target.address, target.family);
			}
		}, (response) => {
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > (deps.maxResponseBytes ?? MAX_RESPONSE_BYTES)) {
					// Settle first, then tear the socket down WITHOUT an error
					// object: `request.destroy(err)` re-emits it on the socket
					// once the response has started, which crashes the process.
					fail(statusError("invalid-response", "upstream response exceeds the size limit"));
					request.destroy();
				} else {
					chunks.push(chunk);
				}
			});
			response.on("end", () => {
				const body = Buffer.concat(chunks);
				done({
					ok: response.statusCode >= 200 && response.statusCode < 300,
					status: response.statusCode,
					headers: responseHeaders(response.headers),
					arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
					json: async () => JSON.parse(body.toString("utf8")),
					text: async () => body.toString("utf8")
				});
			});
			response.on("error", (error) => fail(error));
			response.on("aborted", () => fail(statusError("unavailable", "upstream response was aborted")));
			// `close` always follows; it is the last chance to settle a stream that
			// neither ended nor errored.
			response.on("close", () => {
				if (!response.readableEnded) fail(statusError("unavailable", "upstream response closed before it completed"));
			});
		});
		request.on("error", fail);
		request.end();
	});
}

function balanceAlert(balance, warning) {
	const remaining = numberOrNull(balance?.remaining);
	const warnBelow = numberOrNull(warning?.warnBelow);
	const criticalBelow = numberOrNull(warning?.criticalBelow);
	if (remaining !== null && (warnBelow !== null || criticalBelow !== null)) {
		if (criticalBelow !== null && remaining <= criticalBelow) return { level: "critical", metric: "balance", value: remaining, threshold: criticalBelow };
		if (warnBelow !== null && remaining <= warnBelow) return { level: "warning", metric: "balance", value: remaining, threshold: warnBelow };
		return { level: "normal", metric: "balance", value: remaining };
	}
	const total = numberOrNull(balance?.total);
	if (remaining !== null && total !== null && total > 0) {
		const value = round1(Math.max(0, Math.min(100, remaining / total * 100)));
		return { level: value <= 10 ? "critical" : value <= 30 ? "warning" : "normal", metric: "remaining-percent", value };
	}
	return { level: "unknown", metric: "balance", value: remaining };
}

function baseSnapshot(spec, status, now) {
	return {
		id: spec.id,
		displayName: spec.displayName,
		mode: spec.mode ?? "balance",
		adapter: spec.adapter,
		status,
		fetchedAt: now
	};
}

function unavailableSnapshot(spec, status, now, extra = {}) {
	return { ...baseSnapshot(spec, status, now), balance: null, alert: { level: "unknown", metric: "balance", value: null }, ...extra };
}

async function queryDeepSeekBalance(credential, baseURL, deps, now) {
	const scheme = balanceSchemeOf(DEEPSEEK_SPEC.id);
	const raw = await queryBalance(scheme, baseURL, credential, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, deps.fetch ?? fetch);
	const remaining = numberOrNull(raw.total);
	if (remaining === null) throw statusError("invalid-response", "balance response is missing a numeric amount");
	const used = numberOrNull(raw.used);
	const total = numberOrNull(raw.limit);
	const balance = {
		remaining,
		...(used === null ? {} : { used }),
		...(total === null ? {} : { total }),
		currency: nonEmptyString(raw.currency) ?? "USD",
		unlimited: false,
		expiresAt: null,
		available: raw.isAvailable !== false,
		breakdown: {
			granted: numberOrNull(raw.granted),
			toppedUp: numberOrNull(raw.toppedUp)
		}
	};
	// DeepSeek's explicit `is_available` flag is an upstream account state: a
	// numeric zero balance remains a valid successful response and should still
	// render the critical balance.
	const status = raw.isAvailable === false ? "unavailable" : "ok";
	return { ...baseSnapshot(DEEPSEEK_SPEC, status, now), balance, alert: balanceAlert(balance) };
}

/** Query the DeepSeek balance endpoint and return a secret-free normalized snapshot. */
export async function queryAccount(credentials, deps = {}) {
	const now = (deps.now ?? Date.now)();
	const baseURL = nonEmptyString(deps.baseURL) ?? DEEPSEEK_BASE_URL;
	const apiKeyRef = nonEmptyString(deps.apiKeyRef) ?? DEEPSEEK_API_KEY_REF;
	try {
		const safeDeps = deps.fetch === void 0 ? { ...deps, fetch: (url, init) => pinnedFetch(url, init, deps) } : deps;
		const credential = await resolveCredential(credentials, apiKeyRef);
		if (credential === "") return unavailableSnapshot(DEEPSEEK_SPEC, "not-configured", now, { missingCredentials: [apiKeyRef] });
		return await queryDeepSeekBalance(credential, baseURL, safeDeps, now);
	} catch (error) {
		return unavailableSnapshot(DEEPSEEK_SPEC, statusOf(error), now, policyDetail(error));
	}
}

function isTransient(status) {
	return status === "unavailable" || status === "rate-limited" || status === "invalid-response";
}

/**
 * Preserve the last successful balance through transient upstream failures.
 * `previous` must be the last snapshot whose status was `ok` (see `refresh()`):
 * after one transient failure the cache entry itself is the failure, so using it
 * as the fallback lost the balance the second time the upstream broke.
 * Non-transient states (not-configured, unauthorized) intentionally keep showing
 * no balance.
 */
function withStaleData(previous, current) {
	if (previous?.status !== "ok" || !isTransient(current.status)) return current;
	return {
		...previous,
		status: current.status,
		fetchedAt: current.fetchedAt,
		lastSuccessAt: previous.lastSuccessAt ?? previous.fetchedAt,
		stale: true
	};
}

/**
 * In-memory DeepSeek account cache with single-flight and forced refresh.
 * Background scheduling is owned by the server plugin so it can also refresh
 * local token-usage aggregation in the same five-minute cycle.
 *
 * Cache identity is `ref name + base URL + digest of the RESOLVED credential`.
 * A credential reference is only a name: pointing it at another account's key
 * (edit `.credentials.yaml`, rotate the key) must drop the previous balance and
 * its `lastOk` fallback, otherwise a forced query that fails would serve the old
 * account's number as "stale balance" for the new one.
 */
export function createAccountService({ credentials, deps = {} }) {
	const cache = new Map();
	const inflight = new Map();
	const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
	const configKey = `${nonEmptyString(deps.apiKeyRef) ?? DEEPSEEK_API_KEY_REF}|${nonEmptyString(deps.baseURL) ?? DEEPSEEK_BASE_URL}`;

	/** Cache identity for the credential that is in effect right now. */
	async function identityOf() {
		const ref = nonEmptyString(deps.apiKeyRef) ?? DEEPSEEK_API_KEY_REF;
		const secret = await resolveCredential(credentials, ref);
		// Never keep the secret itself: a short digest is enough to tell accounts
		// apart inside this process.
		const digest = secret === "" ? "" : createHash("sha256").update(secret).digest("hex").slice(0, 16);
		return `${configKey}|${digest}`;
	}

	async function query(identity) {
		const current = await queryAccount(credentials, deps);
		const previous = cache.get(DEEPSEEK_SPEC.id);
		// The last successful snapshot is only reusable for the SAME account.
		const previousOk = previous !== void 0 && previous.identity === identity ? previous.lastOk ?? null : null;
		const lastOk = current.status === "ok" ? current : previousOk;
		const next = withStaleData(lastOk, current);
		cache.set(DEEPSEEK_SPEC.id, { identity, configKey, account: next, lastOk });
		return next;
	}

	async function refresh(identity) {
		const existing = inflight.get(identity);
		if (existing !== void 0) return existing;
		const promise = query(identity).finally(() => inflight.delete(identity));
		inflight.set(identity, promise);
		return promise;
	}

	async function get(providerId, { force = false } = {}) {
		if (!DEEPSEEK_IDS.has(providerId)) return null;
		const identity = await identityOf();
		const hit = cache.get(DEEPSEEK_SPEC.id);
		// Account changed under the same ref name: drop the entry (balance + lastOk)
		// instead of answering with the previous account's number.
		if (hit !== void 0 && hit.identity !== identity) cache.delete(DEEPSEEK_SPEC.id);
		const fresh = cache.get(DEEPSEEK_SPEC.id);
		const age = (deps.now ?? Date.now)() - (fresh?.account?.fetchedAt ?? 0);
		if (!force && fresh !== void 0 && age >= 0 && age < refreshMs) return fresh.account;
		return refresh(identity);
	}

	async function refreshAll() {
		return [await refresh(await identityOf())];
	}

	// The only remaining configuration field is usageTokenRef, which
	// validateAccountConfig owns, so nothing provider-specific is left to
	// validate here. Kept as an async hook because the plugin awaits it on mount.
	async function validate() {}

	return {
		get,
		refreshAll,
		validate,
		cached: (providerId) => DEEPSEEK_IDS.has(providerId) ? cache.get(DEEPSEEK_SPEC.id)?.account ?? null : null
	};
}

export const ACCOUNT_REFRESH_MS = DEFAULT_REFRESH_MS;
