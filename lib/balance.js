/**
 * dsh-usage-stats — DeepSeek balance scheme.
 *
 * Pure, testable balance query. The DeepSeek scheme knows the endpoint path
 * (relative to the provider's configured base URL) and how to parse the
 * response into a normalized `{ isAvailable, currency, total, used, limit,
 * granted, toppedUp }` view. Providers without a public balance API map to no
 * scheme — the UI shows an explicit "no public balance interface" state
 * instead of guessing.
 *
 * @module dsh-usage-stats/balance
 */

const SCHEMES = {
	/** DeepSeek: GET {origin}/user/balance — CNY balance_infos entry. */
	deepseek: {
		url: (baseURL) => new URL("/user/balance", baseURL).href,
		parse: (json) => {
			const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : [];
			const info = infos.find((entry) => entry?.currency === "CNY") ?? infos[0];
			return {
				isAvailable: json?.is_available === true,
				currency: info?.currency ?? void 0,
				total: info?.total_balance ?? void 0,
				granted: info?.granted_balance ?? void 0,
				toppedUp: info?.topped_up_balance ?? void 0
			};
		}
	}
};

function providerError(status, message, httpStatus) {
	const error = new Error(message);
	error.providerStatus = status;
	if (httpStatus !== void 0) error.httpStatus = httpStatus;
	return error;
}

function responseStatus(status) {
	if (status === 401 || status === 403) return "unauthorized";
	if (status === 429) return "rate-limited";
	return status >= 500 ? "unavailable" : "invalid-response";
}

/** Map a provider id to a balance scheme id; DeepSeek is the only supported provider. */
export function balanceSchemeOf(providerId) {
	if (providerId === "deepseek-official" || providerId === "deepseek") return "deepseek";
	return null;
}

/** Query one provider's balance. Throws on transport/HTTP errors. */
export async function queryBalance(scheme, baseURL, apiKey, timeoutMs = 15000, fetchImpl = fetch) {
	const spec = SCHEMES[scheme];
	if (spec === void 0) throw new Error(`no balance scheme "${scheme}"`);
	const response = await fetchImpl(spec.url(baseURL), {
		headers: { authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw providerError(responseStatus(response.status), `balance API returned HTTP ${response.status}`, response.status);
	let body;
	try {
		body = await response.json();
	} catch {
		throw providerError("invalid-response", "balance API returned invalid JSON");
	}
	return spec.parse(body);
}
