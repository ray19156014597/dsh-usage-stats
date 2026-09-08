// Smoke-test the hand-written client bundle outside the browser:
// 1. feed it to a fake __ModuleLoader__ (captures the factory)
// 2. run the factory with a fake require (real react, stubbed primitives)
// 3. render <UsageStatsPanel wide t> with react-dom/server
// 4. run apply(ctx) against a stub client context
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Clean clones resolve declared devDependencies locally. An explicit override
// remains useful for checking against the exact modules bundled with dsh.
const require = process.env.SMOKE_NODE_MODULES === void 0
	? createRequire(import.meta.url)
	: createRequire(join(process.env.SMOKE_NODE_MODULES, "_anchor.js"));
const react = require("react");
const jsxRuntime = require("react/jsx-runtime");
const { renderToStaticMarkup } = require("react-dom/server");

// Fake primitives: every named export is a no-op component (returns its props as children is not needed).
const Stub = () => null;
const primitives = new Proxy({}, { get: () => Stub });

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, appendChild: () => {} }), head: { appendChild: () => {} } };

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");
if (!source.includes("/api/usage-stats/account")) throw new Error("client must use the unified account endpoint");
if (source.includes('fetchJson("/api/usage-stats/subscriptions")')) throw new Error("client must not bulk-fetch every subscription provider");
if (!source.includes('closest(`.${S.panel}, .${S.badge}`)')) throw new Error("the panel must close on outside clicks (mousedown guard missing)");
new Function(source)(); // executes the window.__ModuleLoader__.load call

if (captured === null) throw new Error("loader did not capture the bundle");
if (captured.id !== "dsh-usage-stats") throw new Error(`unexpected id ${captured.id}`);

const exports_ = captured.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return jsxRuntime;
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${spec}`);
});

if (typeof exports_.apply !== "function") throw new Error("missing apply export");

// Render the panel (closed state) to static markup.
const { UsageStatsPanel } = exports_;
const markup = renderToStaticMarkup(react.createElement(UsageStatsPanel, { wide: true, t: (key) => key }));
if (!markup.includes("用量/余额") && !markup.includes("panel.badge")) throw new Error("badge label missing from markup");
console.log("render ok, markup length:", markup.length);

// Apply against a stub client context.
const registrations = [];
const ctx = {
	effect: () => {},
	locale: { register: (ns, dict) => { if (ns !== "usageStats") throw new Error(`unexpected ns ${ns}`); if (!dict.zh || !dict.en) throw new Error("missing dictionaries"); } },
	slots: { inject: (slot, fn) => { registrations.push([slot, fn]); return () => {}; }, register: () => () => {} }
};
exports_.apply(ctx);
if (registrations.length !== 1) throw new Error("expected one slot injection");
const [slot, registerFn] = registrations[0];
if (slot !== "sidebar.footer.action") throw new Error(`unexpected slot ${slot}`);
const disposer = registerFn();
if (typeof disposer !== "function") throw new Error("slot registration must return a disposer");
console.log("apply ok, slot:", slot);

// Render the month heatmap with synthetic per-day data (calendar grid + colors).
const { MonthHeatmap, DayDetail, buildMonthHeatmap } = exports_;
const dayMap = new Map();
const now = new Date();
for (let i = 0; i < 40; i += 1) {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
	const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	dayMap.set(key, { tokens: 1000 + i * 137, cacheHitRate: i % 3 === 0 ? null : 90.5 });
}
const heat = buildMonthHeatmap(dayMap, now.getFullYear(), now.getMonth());
if (heat.weeks.length < 4 || heat.weeks.length > 6) throw new Error(`unexpected week count ${heat.weeks.length}`);
for (const week of heat.weeks) if (week.length !== 7) throw new Error("week must have 7 slots");
const heatMarkup = renderToStaticMarkup(react.createElement(MonthHeatmap, {
	heat,
	translate: (key) => key,
	selectedKey: null,
	onSelect: () => {}
}));
if (heatMarkup.length < 500) throw new Error("heatmap markup too small");
if (!heatMarkup.includes("tokens")) throw new Error("heatmap cells missing tooltips");
if (heatMarkup.includes("¥")) throw new Error("local-day tooltips must not include a cost");
// Platform-mapped days carry the daily cost: the tooltip must show the amount.
const platformDayMap = new Map();
platformDayMap.set("2026-08-10", { tokens: 1234567, cacheHitRate: 97.3, cost: 1.23 });
const platformHeat = buildMonthHeatmap(platformDayMap, 2026, 7);
const platformHeatMarkup = renderToStaticMarkup(react.createElement(MonthHeatmap, {
	heat: platformHeat,
	translate: (key) => key,
	selectedKey: null,
	onSelect: () => {},
	currency: "CNY"
}));
if (!platformHeatMarkup.includes("¥1.23")) throw new Error("platform-day tooltips must include the daily cost");
console.log("month heatmap render ok, markup length:", heatMarkup.length, "| weeks:", heat.weeks.length);

// Sqrt blue scale: monotonic in tokens — more usage → deeper blue (higher alpha).
const { cellColor } = exports_;
const levelOf = (tokens, max) => cellColor(tokens, max).alpha;
const levelMap = new Map();
const lkeys = [];
for (let i = 1; i <= 4; i += 1) {
	const d = new Date(now.getFullYear(), now.getMonth(), i);
	const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	levelMap.set(key, { tokens: [1000, 100000, 10000000, 40000000][i - 1], cacheHitRate: 90 });
	lkeys.push(key);
}
const levelHeat = buildMonthHeatmap(levelMap, now.getFullYear(), now.getMonth());
const levels = lkeys.map((key) => levelOf(levelHeat.weeks.flat().find((c) => c !== null && c.key === key).tokens, levelHeat.max));
if (levels[3] !== 1) throw new Error(`max day must be alpha 1 (deep blue), got ${levels[3]}`);
for (let i = 1; i < 4; i += 1) if (levels[i] < levels[i - 1]) throw new Error(`levels not monotonic: ${JSON.stringify(levels)}`);
if (levelOf(0, levelHeat.max) !== 0) throw new Error("zero tokens must be level 0");
if (!cellColor(1000, levelHeat.max).background.includes("color-mix")) throw new Error("background must mix over the theme-aware heat base");
console.log("sqrt blue scale monotonic ok:", JSON.stringify(levels.map((a) => a.toFixed(3))));

// Regression: the panel parses `YYYY-MM` (1-based) from viewMonth; emulate it
// and check the grid lands on the right month (August 2026 starts on Saturday).
const [panelYear, panelMonth] = "2026-08".split("-").map(Number);
const panelHeat = buildMonthHeatmap(levelMap, panelYear, panelMonth - 1);
const firstWeek = panelHeat.weeks[0];
if (firstWeek[5] === null || firstWeek[5].day !== 1) throw new Error(`August 2026 should start with day 1 at weekday index 5, got ${JSON.stringify(firstWeek)}`);
if (firstWeek[0] !== null || firstWeek[4] !== null) throw new Error("August 2026 must lead with 5 empty slots");
console.log("month off-by-one regression ok (Aug 2026 grid correct)");

// Render the day-detail view with per-model breakdown + enriched platform
// metrics (requests/cost) and a token-composition bar with legend.
const dayDetailDay = {
	date: "2026-08-13",
	tokens: 34333358,
	inputTokens: 199382,
	outputTokens: 116824,
	cacheReadTokens: 34017152,
	cacheWriteTokens: 0,
	cacheHitRate: 99.4,
	requestCount: 42,
	cost: 12.34,
	models: [
		{ model: "deepseek-official/deepseek-v4-flash", tokens: 30000000, inputTokens: 100000, outputTokens: 50000, cacheReadTokens: 29000000, cacheWriteTokens: 0, cacheHitRate: 99.6, requestCount: 40, cost: 11.5 },
		{ model: "ark/deepseek-v4-flash", tokens: 4333358, inputTokens: 99382, outputTokens: 66824, cacheReadTokens: 5017152, cacheWriteTokens: 0, cacheHitRate: 98.1, requestCount: 2, cost: 0.84 }
	]
};
const dayDetail = renderToStaticMarkup(react.createElement(DayDetail, {
	day: dayDetailDay,
	dayDetail: {
		source: "by-api-key",
		currency: "CNY",
		hours: Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: hour === 8 ? 1012000 : 0, requestCount: hour === 8 ? 5 : 0, cost: hour === 8 ? 0.35 : 0 })),
		perKey: [{ trackingId: "tid-1", name: "Harness", totalTokens: 1012000, requestCount: 5, cost: 0.35 }],
		perModel: []
	},
	currency: "CNY",
	translate: (key) => key,
	onBack: () => {}
}));
if (!dayDetail.includes("deepseek-v4-flash")) throw new Error("day detail missing model rows");
if (!dayDetail.includes("deepseek-official · deepseek-v4-flash")) throw new Error("day detail must prefix the provider");
if (!dayDetail.includes("ark · deepseek-v4-flash")) throw new Error("same model from another provider must stay distinct");
if (dayDetail.length < 500) throw new Error("day detail markup too small");
if (!dayDetail.includes("usg_dayRing") || !dayDetail.includes("usg_compLegend")) throw new Error("day detail must render the composition ring with a legend");
const inlineStyles = dayDetail.match(/style="[^"]*background[^"]*"/g) ?? [];
if (inlineStyles.length < 6) throw new Error("composition segments must carry their inline colors; got: " + JSON.stringify(inlineStyles.slice(0, 4)));
if (!dayDetail.includes("99.1%") || !dayDetail.includes("0.6%")) throw new Error("composition legend must show per-segment percentages");
if (!dayDetail.includes("usage.cost") || !dayDetail.includes("platform.requests")) throw new Error("platform day metrics (requests/cost) must be rendered");
if (dayDetail.includes("usg_compTrack")) throw new Error("the flat composition track must be replaced by the ring");
if (dayDetail.includes("platform.ratio")) throw new Error("T/¥ must not appear in the day detail");
if (!dayDetail.includes("usage.dayTotal") || !dayDetail.includes("34,333,358")) throw new Error("the hero must show 总消耗 before the number");
if (!dayDetail.includes("usg_dayHeroWrap") || dayDetail.includes("usg_statsBand")) throw new Error("the day hero must use the text-left + ring-right layout, not stat cards");
if (!dayDetail.includes("usg_hourChart") || !dayDetail.includes("usg_hourAxis") || !dayDetail.includes("usg_hourPeak") || !dayDetail.includes("08:00")) throw new Error("day detail must render the hourly pulse with a peak marker");
if ((dayDetail.match(/class="usg_hourCol/g) ?? []).length !== 24) throw new Error("the hourly chart must have 24 columns");
if (dayDetail.includes("00:00 ·") && !dayDetail.includes("00:00–01:00")) throw new Error("hourly tooltips must show the time range");
if (!dayDetail.includes("按 API Key") && !dayDetail.includes("platform.apiKeysTitle")) throw new Error("day detail must render the per-API-Key rows");
if (!dayDetail.includes("Harness")) throw new Error("per-API-Key rows must include the key name");
if ((dayDetail.match(/usg_modelCompTrack/g) ?? []).length < 2) throw new Error("per-model bars must merge share + composition into one track");
console.log("day detail render ok (strip + composition + hourly + per-key), markup length:", dayDetail.length);

// Local-only day entries carry no request/cost and no hourly data.
const dayDetailLocal = renderToStaticMarkup(react.createElement(DayDetail, {
	day: { ...dayDetailDay, requestCount: void 0, cost: void 0 },
	translate: (key) => key,
	onBack: () => {}
}));
if (dayDetailLocal.includes("usage.cost") || dayDetailLocal.includes("platform.requests")) throw new Error("local day detail must hide requests/cost metrics");
if (dayDetailLocal.includes("usg_hourChart") || dayDetailLocal.includes("usg_dayKeys")) throw new Error("local day detail must hide the hourly chart and per-key rows");
console.log("local day detail hides platform metrics ok");

// Balance and subscription providers share one account-card frame. Only the
// selected provider is rendered; the inner payload varies by account mode.
const { ProviderAccountCard, buildProviderChoices } = exports_;
const translateAccount = (key, params) => {
	if (params?.value !== void 0) return `${key}:${params.value}`;
	if (params?.refs !== void 0) return `${key}:${params.refs}`;
	if (params?.ref !== void 0) return `${key}:${params.ref}`;
	return key;
};
const deepseekMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "deepseek-official", displayName: "DeepSeek", accountMode: "balance" },
	account: {
		id: "deepseek-official",
		displayName: "DeepSeek",
		mode: "balance",
		status: "ok",
		balance: { remaining: 36.44, currency: "CNY", unlimited: false, breakdown: { toppedUp: 20, granted: 16.44 } }
	},
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
const goSubscription = {
	id: "opencode-go",
	displayName: "OpenCode Go",
	status: "ok",
	plan: "Go",
	windows: [
		{ kind: "session", usedPercent: 12, remainingPercent: 88, resetsAt: "2026-08-14T01:00:00Z" },
		{ kind: "weekly", usedPercent: 34, remainingPercent: 66 },
		{ kind: "monthly", usedPercent: 56, remainingPercent: 44 }
	]
};
const goMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "opencode-go", displayName: "OpenCode Go", accountMode: "subscription", subscriptionId: "opencode-go" },
	account: { ...goSubscription, mode: "subscription" },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
if (!deepseekMarkup.includes("usg_accountCard") || !goMarkup.includes("usg_accountCard")) throw new Error("both account modes must use the shared card frame");
if (!deepseekMarkup.includes("data-account-mode=\"balance\"") || !deepseekMarkup.includes("DeepSeek") || deepseekMarkup.includes("progressbar")) throw new Error("DeepSeek must render only monetary balance data");
if (!deepseekMarkup.includes("<svg") || !deepseekMarkup.includes("M26.5174")) throw new Error("the DeepSeek mark must be the official whale logo");
if (deepseekMarkup.includes(">DS<")) throw new Error("the DS abbreviation must be replaced by the whale logo");
if (!goMarkup.includes("data-account-mode=\"subscription\"") || !goMarkup.includes("OpenCode Go")) throw new Error("OpenCode Go must render the subscription account mode");
if ((goMarkup.match(/role="progressbar"/g) ?? []).length !== 3 || !goMarkup.includes("width:12%")) throw new Error("OpenCode Go must render three quota meters");
const invalidMarkup = renderToStaticMarkup(react.createElement(ProviderAccountCard, {
	provider: { id: "minimax", displayName: "MiniMax", accountMode: "subscription" },
	account: { id: "minimax", displayName: "MiniMax", mode: "subscription", status: "invalid-response", windows: [] },
	accountLoading: false,
	accountError: null,
	translate: translateAccount,
	onRetry: () => {}
}));
if (!invalidMarkup.includes("account.status.invalidResponse") || !invalidMarkup.includes("account.invalidResponse")) throw new Error("invalid account responses need a distinct status and explanation");

const choices = buildProviderChoices([
	{ id: "deepseek-official", displayName: "DeepSeek", adapter: "deepseek-balance", accountMode: "balance", configured: true },
	{ id: "zai-coding-cn", displayName: "Z.ai CN", adapter: "zai-token-plan", accountMode: "subscription", configured: true },
	{ id: "opencode-go", displayName: "OpenCode Go", adapter: "opencode-go", accountMode: "subscription", configured: true }
]);
if (choices.length !== 3) throw new Error(`provider metadata must remain one row per provider, got ${choices.length}`);
if (choices.find((provider) => provider.id === "zai-coding-cn")?.accountMode !== "subscription") throw new Error("Z.ai must prefer its subscription presentation");
const selectedMarkup = goMarkup;
if (selectedMarkup.includes("DeepSeek") || selectedMarkup.includes("Z.ai")) throw new Error("the account area must render only the selected provider");
console.log("unified single-provider account card ok, balance:", deepseekMarkup.length, "subscription:", goMarkup.length);

// DeepSeek platform usage section: month stats and per-model rows only —
// no heatmap (the platform daily heatmap was removed as incomplete).
const { PlatformSection } = exports_;
const platformData = {
	month: 8,
	year: 2026,
	fetchedAt: Date.now(),
	monthCost: 7.15,
	source: "by-api-key",
	currency: "CNY",
	models: [
		{ key: "deepseek-v4-flash", name: "V4 Flash", totalTokens: 3616000, requestCount: 12, cacheHitTokens: 3400000, cacheMissTokens: 120000, responseTokens: 96000, cost: 1.55 },
		{ key: "deepseek-v4-pro", name: "V4 Pro", totalTokens: 610000, requestCount: 4, cacheHitTokens: 500000, cacheMissTokens: 80000, responseTokens: 30000, cost: 5.6 }
	],
	apiKeys: [
		{ trackingId: "tid-1", name: "Harness", totalTokens: 5554000, requestCount: 21, cacheHitTokens: 5200000, cacheMissTokens: 200000, responseTokens: 154000, cost: 1.75 },
		{ trackingId: "tid-2", name: "Codex", totalTokens: 610000, requestCount: 4, cacheHitTokens: 500000, cacheMissTokens: 80000, responseTokens: 30000, cost: 5.6 }
	],
	days: [
		{ date: "2026-08-01", totalTokens: 1808000, totalCost: 0.78, totalRequests: 12, models: { "deepseek-v4-flash": { cacheHitTokens: 1700000, cacheMissTokens: 60000, responseTokens: 48000, requestCount: 12, cost: 0.78 } } },
		{ date: "2026-08-02", totalTokens: 610000, totalCost: 5.6, totalRequests: 4, models: { "deepseek-v4-pro": { cacheHitTokens: 500000, cacheMissTokens: 80000, responseTokens: 30000, requestCount: 4, cost: 5.6 } } }
	]
};
const platformMarkup = renderToStaticMarkup(react.createElement(PlatformSection, {
	platform: platformData,
	loading: false,
	error: null,
	month: "2026-08",
	onMonthChange: () => {},
	onRetry: () => {},
	translate: (key, params) => (params?.ref !== void 0 ? `${key}:${params.ref}` : key)
}));
if (!platformMarkup.includes("V4 Flash") || !platformMarkup.includes("V4 Pro")) throw new Error("platform section missing model rows");
if (!platformMarkup.includes("platform.monthCost") || !platformMarkup.includes("platform.todayCost")) throw new Error("platform section missing cost stats");
if (platformMarkup.includes("platform.apiKeysTitle") || platformMarkup.includes("Harness")) throw new Error("the per-api-key block must live at the end of the panel, not inside the platform section");
if (platformMarkup.includes("platform.tzHint") || platformMarkup.includes("UTC")) throw new Error("the UTC+0 timezone notice must be gone");
if (platformMarkup.includes("usg_cell") || platformMarkup.includes("usg_monthGrid") || platformMarkup.includes("platform.heatmap")) throw new Error("the platform section must not render a heatmap");
const noCredentialMarkup = renderToStaticMarkup(react.createElement(PlatformSection, {
	platform: null,
	loading: false,
	error: null,
	month: "2026-08",
	onMonthChange: () => {},
	onRetry: () => {},
	translate: (key, params) => (params?.ref !== void 0 ? `${key}:${params.ref}` : key)
}));
if (!noCredentialMarkup.includes("platform.noCredential:DEEPSEEK_USAGE_TOKEN")) throw new Error("platform section must show the usage-token hint when unconfigured");
// Without apiKeys (legacy fallback payload) the per-key block must hide.
const legacyPlatformMarkup = renderToStaticMarkup(react.createElement(PlatformSection, {
	platform: { ...platformData, apiKeys: void 0 },
	loading: false,
	error: null,
	month: "2026-08",
	onMonthChange: () => {},
	onRetry: () => {},
	translate: (key, params) => (params?.ref !== void 0 ? `${key}:${params.ref}` : key)
}));
if (legacyPlatformMarkup.includes("platform.apiKeysTitle")) throw new Error("the per-api-key block must hide when apiKeys is absent (legacy payload)");

// Collapsible per-API-Key disclosure at the end of the panel: closed by default
// (title + count only), opens to the per-key rows, hides when empty.
const { ApiKeysSection } = exports_;
const apiKeysList = [
	{ trackingId: "tid-1", name: "Harness", totalTokens: 5554000, requestCount: 21, cacheHitTokens: 5200000, cacheMissTokens: 200000, responseTokens: 154000, cost: 1.75 },
	{ trackingId: "tid-2", name: "Codex", totalTokens: 610000, requestCount: 4, cacheHitTokens: 500000, cacheMissTokens: 80000, responseTokens: 30000, cost: 5.6 }
];
const apiKeysClosed = renderToStaticMarkup(react.createElement(ApiKeysSection, {
	apiKeys: apiKeysList,
	currency: "CNY",
	open: false,
	onToggle: () => {},
	translate: (key) => key
}));
if (!apiKeysClosed.includes("platform.apiKeysTitle") || !apiKeysClosed.includes('aria-expanded="false"')) throw new Error("the per-api-key disclosure must render a closed toggle header");
if (apiKeysClosed.includes("Harness") || apiKeysClosed.includes("5554000")) throw new Error("closed disclosure must not render the key rows");
const apiKeysOpen = renderToStaticMarkup(react.createElement(ApiKeysSection, {
	apiKeys: apiKeysList,
	currency: "CNY",
	open: true,
	onToggle: () => {},
	translate: (key) => key
}));
if (!apiKeysOpen.includes("Harness") || !apiKeysOpen.includes("Codex") || !apiKeysOpen.includes('aria-expanded="true"')) throw new Error("open disclosure must render the per-key rows");
const apiKeysEmpty = renderToStaticMarkup(react.createElement(ApiKeysSection, {
	apiKeys: void 0,
	currency: "CNY",
	open: false,
	onToggle: () => {},
	translate: (key) => key
}));
if (apiKeysEmpty !== "") throw new Error("empty apiKeys list must render nothing");
console.log("per-api-key collapsible disclosure ok");

// The merged DeepSeek card: balance + unified stats band + platform usage in ONE card.
const { DeepSeekAccountUsageCard } = exports_;
const mergedCard = renderToStaticMarkup(react.createElement(DeepSeekAccountUsageCard, {
	provider: { id: "deepseek-official", displayName: "DeepSeek", accountMode: "balance" },
	account: { id: "deepseek-official", displayName: "DeepSeek", mode: "balance", status: "ok", balance: { remaining: 44.53, currency: "CNY", unlimited: false, breakdown: { toppedUp: 44.53, granted: 0 } } },
	accountLoading: false,
	accountError: null,
	platform: platformData,
	platformLoading: false,
	platformError: null,
	month: "2026-08",
	onMonthChange: () => {},
	onRetry: () => {},
	onRetryPlatform: () => {},
	onConfigure: () => {},
	localDayTokens: 786432,
	localMonthTokens: 98765432,
	localTotalTokens: 1234567890,
	translate: (key) => key
}));
if (!mergedCard.includes("usg_accountCard") || !mergedCard.includes("44.53")) throw new Error("merged card must keep the provider balance frame");
if (mergedCard.includes("usg_balanceRowsCompact")) throw new Error("the compact balance detail rows must be removed");
if (!mergedCard.includes("usg_bandCompact")) throw new Error("the stats band must use the compact layout");
if (!mergedCard.includes("usage.todayTokens") || !mergedCard.includes("usage.monthTokens") || !mergedCard.includes("usage.totalTokens")) throw new Error("merged card must include the unified statistics band (local tokens)");
if (!mergedCard.includes("platform.monthCost") || !mergedCard.includes("platform.todayCost") || !mergedCard.includes("platform.monthRequests")) throw new Error("merged card unified band must include platform stats");
if (mergedCard.includes("usg_platformDivider")) throw new Error("the platform detail must move out of the account card");
if (mergedCard.includes("platform.title") || mergedCard.includes("V4 Flash")) throw new Error("platform model rows must be a separate section, not embedded in the account card");
if (mergedCard.includes("usage.bandSource")) throw new Error("the band source note must be removed");
const mergedNoPlatform = renderToStaticMarkup(react.createElement(DeepSeekAccountUsageCard, {
	provider: { id: "deepseek-official", displayName: "DeepSeek", accountMode: "balance" },
	account: { id: "deepseek-official", displayName: "DeepSeek", mode: "balance", status: "ok", balance: { remaining: 10, currency: "CNY", unlimited: false, breakdown: { toppedUp: 10, granted: 0 } } },
	accountLoading: false,
	accountError: null,
	platform: null,
	platformLoading: false,
	platformError: null,
	month: "2026-08",
	onMonthChange: () => {},
	onRetry: () => {},
	onRetryPlatform: () => {},
	onConfigure: () => {},
	localDayTokens: 5,
	localMonthTokens: 6,
	localTotalTokens: 7,
	translate: (key) => key
}));
if (mergedNoPlatform.includes("usage.bandSource")) throw new Error("the platform source note must hide without platform data");
console.log("merged DeepSeek account+usage card ok");

// The merged account module shows platform usage only for DeepSeek providers.
const { isDeepSeekProviderId } = exports_;
if (!isDeepSeekProviderId("deepseek-official") || !isDeepSeekProviderId("deepseek")) throw new Error("official DeepSeek routes must include platform usage");
if (isDeepSeekProviderId("opencode-go") || isDeepSeekProviderId("zai") || isDeepSeekProviderId(null)) throw new Error("non-DeepSeek providers must not show platform usage");
if (!platformMarkup.includes("platform.title")) throw new Error("the platform block must keep its small caption (no separate big title)");

// The single heatmap consumes platform days through the local-shape mapper
// (so day drill-down keeps working for platform data).
const { platformDayBreakdown, platformDayHitRate, platformDayToLocalShape } = exports_;
const breakdown = platformDayBreakdown(platformData.days[0]);
if (breakdown.total !== 1808000 || breakdown.hit !== 1700000) throw new Error("platformDayBreakdown must sum per-model hit/miss/output");
const dayHit = platformDayHitRate(platformData.days[0]);
if (dayHit !== 96.6) throw new Error(`platformDayHitRate must be hit/(hit+miss), got ${dayHit}`);
if (platformDayHitRate({ date: "2026-08-03", models: {} }) !== null) throw new Error("a day without prompt tokens must have a null hit rate");
const mapped = platformDayToLocalShape(platformData.days[0]);
if (mapped.tokens !== 1808000 || mapped.cacheReadTokens !== 1700000 || mapped.inputTokens !== 60000 || mapped.outputTokens !== 48000) throw new Error("platform day must map hits→cacheRead, misses→input, responses→output");
if (mapped.cacheHitRate !== 96.6) throw new Error("mapped day must carry the platform cache hit rate");
if (mapped.requestCount !== 12 || mapped.cost !== 0.78) throw new Error("mapped day must carry request/cost metrics for drill-down");
if (mapped.models.length !== 1 || mapped.models[0].model !== "deepseek-v4-flash") throw new Error("mapped day must keep per-model rows for the detail view");
if (mapped.models[0].requestCount !== 12 || mapped.models[0].cost !== 0.78) throw new Error("mapped per-model rows must carry request/cost");
console.log("platform usage section render ok");

// Month alignment: tokensForMonth sums only the days of the given month key.
const { tokensForMonth } = exports_;
const crossMonthDays = [
	{ date: "2026-07-31", tokens: 100 },
	{ date: "2026-08-01", tokens: 200 },
	{ date: "2026-08-31", tokens: 300 },
	{ date: "2026-09-01", tokens: 400 }
];
if (tokensForMonth(crossMonthDays, "2026-08") !== 500) throw new Error("tokensForMonth must sum only the target month's days");
if (tokensForMonth(crossMonthDays, "2026-07") !== 100 || tokensForMonth(crossMonthDays, "2026-09") !== 400) throw new Error("tokensForMonth must respect neighboring months");
if (tokensForMonth(crossMonthDays, "2026-10") !== 0 || tokensForMonth([], "2026-08") !== 0) throw new Error("tokensForMonth must return 0 when the month has no days");
console.log("tokensForMonth month alignment ok:", tokensForMonth(crossMonthDays, "2026-08"));

// Recent-14-days list must be source-unified with the heatmap: platform days
// win (the heatmap is platform-fed, so 9/3 + 9/4 must appear even when the
// local session log has no September days), local days fill the gaps, and
// same-date local entries must not override the platform value.
const { recentDaysOf } = exports_;
const recentPlatMap = new Map([
	["2026-09-03", { date: "2026-09-03", tokens: 7200000, cacheHitRate: 91.2, cost: 0.88 }],
	["2026-09-04", { date: "2026-09-04", tokens: 1500000, cacheHitRate: 88.6, cost: 0.21 }]
]);
const recentLocalDays = [
	{ date: "2026-08-23", tokens: 100000, cacheHitRate: 95 },
	{ date: "2026-08-24", tokens: 200000, cacheHitRate: 96 },
	{ date: "2026-08-25", tokens: 50000, cacheHitRate: null },
	{ date: "2026-08-31", tokens: 1010000, cacheHitRate: 99 },
	{ date: "2026-09-03", tokens: 999, cacheHitRate: 1 }
];
const recentList = recentDaysOf(recentPlatMap, recentLocalDays, "2026-08-23", "2026-09-05");
if (recentList.length !== 6) throw new Error(`recent list must merge platform + local days, got ${recentList.length}`);
const recentDates = recentList.map((day) => day.date);
if (recentDates[0] !== "2026-09-04" || recentDates[1] !== "2026-09-03") throw new Error(`recent list must be newest-first: ${JSON.stringify(recentDates)}`);
const sept3 = recentList.find((day) => day.date === "2026-09-03");
if (sept3.tokens !== 7200000 || sept3.cacheHitRate !== 91.2) throw new Error("platform day must win over a same-date local entry");
if (!recentList.some((day) => day.date === "2026-08-31") || !recentList.some((day) => day.date === "2026-08-23")) throw new Error("local-only days must stay in the recent list");
if (recentDaysOf(recentPlatMap, [], "2026-08-23", "2026-09-05").length !== 2) throw new Error("platform-only recent data must render without local days");
if (recentDaysOf(null, recentLocalDays, "2026-08-23", "2026-09-05").length !== 5) throw new Error("recent list must fall back to local days when platform data is unavailable");
if (recentDaysOf(recentPlatMap, recentLocalDays, "2026-09-01", "2026-09-05").length !== 2) throw new Error("recent list must be clipped to the 14-day window");
console.log("recent-14-days source unification ok (platform wins, local fills gaps):", recentDates.join(", "));

// Settings view: web-login auto-sync (method 1) + token management (method 2).
const { TokenSettingsView } = exports_;
const settingsMarkup = renderToStaticMarkup(react.createElement(TokenSettingsView, {
	status: { configured: true, source: "stored" },
	busy: false,
	message: "saved",
	value: "",
	onChange: () => {},
	onPaste: () => {},
	onSave: () => {},
	onClear: () => {},
	syncRunning: false,
	onStartSync: () => {},
	onStopSync: () => {},
	onBack: () => {},
	translate: (key, params) => (params?.message !== void 0 ? `${key}:${params.message}` : params?.cost !== void 0 ? `${key}:${params.cost}` : params?.source !== void 0 ? `${key}:${params.source}` : key)
}));
if (!settingsMarkup.includes("token.title") || !settingsMarkup.includes("token.save") || !settingsMarkup.includes("token.clear")) throw new Error("settings view missing token management controls");
if (!settingsMarkup.includes("token.method1") || !settingsMarkup.includes("token.syncButton")) throw new Error("settings view missing the web-login auto-sync method");
if (!settingsMarkup.includes("type=\"password\"")) throw new Error("token input must be a password field");
if (!settingsMarkup.includes("token.configured")) throw new Error("settings view must show the configured state");
const settingsSyncMarkup = renderToStaticMarkup(react.createElement(TokenSettingsView, {
	status: { configured: false, source: null },
	busy: false,
	message: "",
	value: "",
	onChange: () => {},
	onPaste: () => {},
	onSave: () => {},
	onClear: () => {},
	syncRunning: true,
	onStartSync: () => {},
	onStopSync: () => {},
	onBack: () => {},
	translate: (key) => key
}));
if (!settingsSyncMarkup.includes("token.syncStop")) throw new Error("a running sync must offer the stop button");
const settingsEmptyMarkup = renderToStaticMarkup(react.createElement(TokenSettingsView, {
	status: { configured: false, source: null },
	busy: false,
	message: "",
	value: "",
	onChange: () => {},
	onPaste: () => {},
	onSave: () => {},
	onClear: () => {},
	syncRunning: false,
	onStartSync: () => {},
	onStopSync: () => {},
	onBack: () => {},
	translate: (key) => key
}));
if (!settingsEmptyMarkup.includes("token.notConfigured")) throw new Error("settings view must show the unconfigured state");
console.log("token settings view render ok");

// Race regression (P1): usage and account must each keep their OWN staleness
// counter, so an account request issued right after a usage request must NOT
// invalidate the in-flight usage response.
const { createLoader, fmtCurrency } = exports_;
const usageLoader = createLoader();
const accountLoader = createLoader();
const usageId = usageLoader.start();
const accountId = accountLoader.start();
if (!usageLoader.isCurrent(usageId)) throw new Error("race: account start invalidated the usage request");
if (!accountLoader.isCurrent(accountId)) throw new Error("account request must stay current");
usageLoader.start(); // a newer usage refresh supersedes the old one
if (usageLoader.isCurrent(usageId)) throw new Error("a newer usage start must supersede the previous usage request");
if (!accountLoader.isCurrent(accountId)) throw new Error("account must not be affected by usage refreshes");
console.log("loader race regression ok (independent usage/account counters)");

// Currency formatting must respect the reported currency, not hardcode ¥.
const cny = fmtCurrency("36.44", "CNY");
if (!cny.includes("36.44")) throw new Error(`unexpected CNY format: ${cny}`);
if (fmtCurrency(void 0, "CNY") !== "—") throw new Error("missing amount must render em dash");
if (fmtCurrency("9.9", "USD").includes("¥")) throw new Error("USD must not render as ¥");
console.log("currency formatting ok:", cny);
console.log("SMOKE TEST PASSED");
