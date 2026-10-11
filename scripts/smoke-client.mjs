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

// Fake primitives: exactly the 0.1.7 surface the bundle may ask for. A catch-all
// Proxy would hide the breakage this file exists to catch — a renamed icon
// silently resolving to a stub — so the export map stays explicit.
const Stub = () => null;
const ICON_EXPORTS = [
	"IconChevronLeftOutlineRegular",
	"IconChevronRightOutlineRegular",
	"IconCloseOutlineRegular",
	"IconDataOutlineRegular",
	"IconRefreshOutlineRegular",
	"IconSettingsOutlineRegular"
];
const primitives = Object.fromEntries(ICON_EXPORTS.map((name) => [name, Stub]));

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, appendChild: () => {} }), head: { appendChild: () => {} } };

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js"), "utf8");
if (!source.includes("/api/usage-stats/account")) throw new Error("client must use the unified account endpoint");
// The server dropped the multi-provider/subscription endpoints: the client must
// not call any of them.
for (const endpoint of ["/api/usage-stats/providers", "/api/usage-stats/balance", "/api/usage-stats/subscriptions"]) {
	if (source.includes(endpoint)) throw new Error(`client must not call the removed endpoint ${endpoint}`);
}
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

// Icon surface: dsh 0.1.7 renamed every primitives icon (trailing optical size →
// stroke-weight suffix). The bundle must request the new names, must not touch
// `primitives.Icon*` directly, and must still mount on a host that exports none
// of them — the regression that made the whole panel disappear on 0.1.7.
for (const name of ICON_EXPORTS) {
	if (!source.includes(name)) throw new Error(`client must request the 0.1.7 icon ${name}`);
}
if (/primitives\.Icon/.test(source)) throw new Error("icons must be resolved through resolveIcon(), not read off primitives directly");

// Degradation: an empty primitives module must not break the render.
let bareCaptured = null;
globalThis.window = { __ModuleLoader__: { load: (entry) => { bareCaptured = entry; } } };
new Function(source)();
const bareExports = bareCaptured.factory((spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return jsxRuntime;
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return {};
	throw new Error(`unexpected require: ${spec}`);
});
const bareMarkup = renderToStaticMarkup(react.createElement(bareExports.UsageStatsPanel, { wide: true, t: (key) => key }));
if (bareMarkup.length < 200 || !bareMarkup.includes("panel.badge")) {
	throw new Error(`the panel must still render when the host exports no icons (got ${bareMarkup.length} chars)`);
}

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
// 口径一致性：图例是"占当日总量"的构成份额，环心是"按输入侧算"的命中率。
// 两者分母不同（97.2% vs 98.1%），所以不能共用同一个词；环心必须写明分母。
if (!dayDetail.includes("usg_dayRingNote") || !dayDetail.includes("usage.hitRateNote")) {
	throw new Error("the ring centre must state the hit-rate denominator, not just a bare percentage");
}
for (const [fragment, label] of [
	['"usage.hitRate": "缓存命中率"', "zh rate label"],
	['"usage.hitRateNote": "占输入"', "zh rate denominator"],
	['"usage.hitRate": "Cache hit rate"', "en rate label"],
	['"usage.hitRateNote": "of prompt"', "en rate denominator"],
	['"platform.hit": "缓存命中"', "zh token-category label"],
	['"platform.cacheHit": "缓存命中率"', "zh platform rate label"]
]) {
	if (!source.includes(fragment)) throw new Error(`cache-hit wording contract missing: ${label} (${fragment})`);
}
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

// The client is DeepSeek-only: the provider picker, the shared multi-provider
// account frame and the subscription quota meters were removed, so their
// symbols must no longer be exported and none of their UI strings may remain.
for (const symbol of ["ProviderAccountCard", "ProviderPicker", "SubscriptionContent", "buildProviderChoices", "isDeepSeekProviderId", "quotaLabel", "resetLabel"]) {
	if (Object.hasOwn(exports_, symbol)) throw new Error(`removed multi-provider export still present: ${symbol}`);
}
for (const fragment of ["usg_providerPicker", "usg_providerSelect", "usg_accountGrid", "usg_quotaTrack", "usg_quotaFill", "usg_quotaLabel", "subscription.", "account.provider", "balance.title", "data-provider=opencode-go", "data-provider=zai", "data-provider=openrouter", "data-provider=moonshotai", "data-provider=kimi"]) {
	if (source.includes(fragment)) throw new Error(`removed multi-provider UI fragment still present: ${fragment}`);
}
// The merged DeepSeek card keeps the balance frame, the official whale mark and
// the unified stats band. (Its full coverage continues further below.)
const cardOnlyMarkup = renderToStaticMarkup(react.createElement(exports_.DeepSeekAccountUsageCard, {
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
	platform: null,
	platformLoading: false,
	platformError: null,
	month: "2026-08",
	onMonthChange: () => {},
	onRetry: () => {},
	onRetryPlatform: () => {},
	onConfigure: () => {},
	localDayTokens: 1,
	localMonthTokens: 2,
	localTotalTokens: 3,
	translate: (key) => key
}));
if (!cardOnlyMarkup.includes("usg_accountCard") || !cardOnlyMarkup.includes("36.44") || !cardOnlyMarkup.includes("data-account-mode=\"balance\"")) throw new Error("the DeepSeek card must keep the balance frame");
if (!cardOnlyMarkup.includes("<svg") || !cardOnlyMarkup.includes("M26.5174")) throw new Error("the DeepSeek mark must be the official whale logo");
if (cardOnlyMarkup.includes(">DS<")) throw new Error("the DS abbreviation must be replaced by the whale logo");
if (!cardOnlyMarkup.includes("usg_bandCompact") || !cardOnlyMarkup.includes("usage.totalTokens")) throw new Error("the DeepSeek card must keep the unified stats band");
if (cardOnlyMarkup.includes("progressbar") || cardOnlyMarkup.includes("usg_quotaTrack")) throw new Error("the DeepSeek card must render balance only (no quota meters)");
console.log("deepseek-only account card ok, markup length:", cardOnlyMarkup.length);

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

// The merged account module shows platform usage only for DeepSeek providers;
// the removed provider guard no longer exists (asserted absent above).
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
// ---- P0 interaction polish -------------------------------------------------
// Motion: the panel must grow out of the sidebar badge and take long enough to be
// perceived (the old 160ms/6px fade was invisible), and closing must animate out
// before the node unmounts. The JS exit timer must match the stylesheet duration.
const inMatch = source.match(/usg-panel-in (\d+)ms/);
const outMatch = source.match(/usg-panel-out (\d+)ms/);
if (inMatch === null) throw new Error("the panel must declare an entry animation duration");
if (outMatch === null) throw new Error("the panel must declare an exit animation");
if (Number(inMatch[1]) < 340) throw new Error(`entry animation must last at least 340ms, got ${inMatch[1]}ms`);
if (Number(outMatch[1]) < 160 || Number(outMatch[1]) > Number(inMatch[1])) {
	throw new Error(`exit (${outMatch[1]}ms) must be shorter than entry (${inMatch[1]}ms) but still visible`);
}
const bodyMatch = source.match(/usg-body-in (\d+)ms/);
if (bodyMatch === null || Number(bodyMatch[1]) < Number(inMatch[1])) {
	throw new Error("the body fade must not finish before the panel frame settles");
}
const exitConst = source.match(/PANEL_EXIT_MS = (\d+)/);
if (exitConst === null || Number(exitConst[1]) !== Number(outMatch[1])) {
	throw new Error(`PANEL_EXIT_MS must mirror the usg-panel-out duration (${outMatch[1]}ms)`);
}
for (const fragment of ["usg-panel-out", "data-closing", "transform-origin:left bottom", "animation:usg-body-in", "prefers-reduced-motion:reduce", "translateY(18px) scale(.94)"]) {
	if (!source.includes(fragment)) throw new Error(`missing motion contract: ${fragment}`);
}
if (!/"Escape"/.test(source)) throw new Error("the panel must close (or step back) on Escape");
if (!source.includes('translate("action.refreshing")') || !source.includes('"data-busy"')) {
	throw new Error("the refresh control must expose a busy state");
}
if (!source.includes("usg-spin")) throw new Error("the busy refresh icon must spin");
if (!source.includes("UsageSkeleton") || !source.includes("usg_skelGrid")) throw new Error("first paint must use the usage skeleton");
if (!source.includes("usg_errorText")) throw new Error("long error messages must be clamped to a compact block");
if (!source.includes('"action.refreshing": "刷新中…"') || !source.includes('"action.refreshing": "Refreshing…"')) {
	throw new Error("action.refreshing must exist in both dictionaries");
}
for (const fragment of ["usg_headerHint", "data-kind=close", "aspect-ratio:1/1;border-radius:8px"]) {
	if (!source.includes(fragment)) throw new Error(`missing P0 style: ${fragment}`);
}
console.log("P0 interaction polish contract ok (motion", `${inMatch[1]}ms in / ${outMatch[1]}ms out)`);

// Theme follow: the heatmap scale must key off the DSH theme snapshot, because the
// GUI preference can differ from the OS color scheme (OS dark + GUI light etc.).
const { resolveColorScheme, createThemeBridge, prefersReducedMotion } = exports_;
const bridgeOf = (scheme) => ({ scheme: () => scheme });
if (resolveColorScheme(bridgeOf("light")) !== "light") throw new Error("a light theme snapshot must win over the OS scheme");
if (resolveColorScheme(bridgeOf("dark")) !== "dark") throw new Error("a dark theme snapshot must win over the OS scheme");
if (resolveColorScheme(bridgeOf(null)) !== "light") throw new Error("no snapshot must fall back to the media query (node: no matchMedia → light)");
if (resolveColorScheme(void 0) !== "light") throw new Error("a missing bridge must fall back to the media query");
const boundEvents = [];
const bridge = createThemeBridge({
	get: (key) => (key === "theme" ? { getTheme: () => ({ active: { colorScheme: "dark" } }) } : void 0),
	on: (name, listener) => { boundEvents.push([name, listener]); return () => {}; }
});
if (bridge.scheme() !== "dark") throw new Error("the bridge must read ctx.get('theme').getTheme().active.colorScheme");
const listener = () => {};
bridge.subscribe(listener);
if (boundEvents.length !== 1 || boundEvents[0][0] !== "theme/change" || boundEvents[0][1] !== listener) {
	throw new Error(`the bridge must subscribe to theme/change, got ${JSON.stringify(boundEvents.map((e) => e[0]))}`);
}
const bareBridge = createThemeBridge({});
if (bareBridge.scheme() !== null) throw new Error("a context without services must resolve to null (media-query fallback)");
if (typeof bareBridge.subscribe(listener) !== "function") throw new Error("subscribe must always return a disposer");
if (typeof prefersReducedMotion() !== "boolean") throw new Error("prefersReducedMotion must return a boolean without matchMedia");
console.log("theme bridge ok (snapshot wins, media query is the fallback)");

// ---- P1 interaction depth --------------------------------------------------
// View transitions: drilling into the day detail / settings slides in from the
// right, returning slides in from the left, and the container is re-keyed so the
// animation replays (which also resets the scroll position).
for (const fragment of ["usg_body[data-dir=forward]", "usg_body[data-dir=back]", "usg-view-forward", "usg-view-back", '"data-dir": viewDir || void 0', "key: view"]) {
	if (!source.includes(fragment)) throw new Error(`missing view-transition contract: ${fragment}`);
}
// Focus management: the panel takes focus when it opens, the view container when
// the view changes, and focus returns to the badge only if it was inside the panel.
for (const fragment of ["panelRef.current?.focus?.({ preventScroll: true })", "bodyRef.current?.focus?.({ preventScroll: true })", "badgeRef.current?.focus?.({ preventScroll: true })", "panel.contains(active)", "ref: panelRef", "ref: badgeRef"]) {
	if (!source.includes(fragment)) throw new Error(`missing focus-management contract: ${fragment}`);
}
if (!source.includes("preventScroll")) throw new Error("programmatic focus must not scroll the page");
// In-panel tooltip replaces the native title attribute on heatmap cells.
if (!source.includes("usg_tip") || !source.includes('role: "tooltip"') || !source.includes("hoverTip")) {
	throw new Error("the heatmap must use the in-panel tooltip");
}
if (source.includes("title: `${cell.key}")) throw new Error("heatmap cells must not keep the native title tooltip");
if (!source.includes('"usage.monthTokensFor"') || !source.includes('"usage.monthTokensFor": "{month} Tokens"') || !source.includes('"usage.monthTokensFor": "{month} tokens"')) {
	throw new Error("the band label must be able to follow the viewed month (both dictionaries)");
}
if (!source.includes("onMouseEnter: wide ? void 0 :")) throw new Error("the collapsed (rail) badge must expose the today-token hint");
console.log("P1 interaction contract ok (view transitions, focus, tooltip, month label)");

// Cells keep an accessible label but drop the OS-styled title tooltip.
const tippedHeat = renderToStaticMarkup(react.createElement(MonthHeatmap, {
	heat: platformHeat,
	translate: (key) => key,
	selectedKey: null,
	onSelect: () => {},
	currency: "CNY",
	hoverTip: { show: () => {}, hide: () => {} }
}));
if (tippedHeat.includes("title=")) throw new Error("heatmap cells must not render a native title attribute");
if (!tippedHeat.includes("aria-label")) throw new Error("heatmap cells must stay labelled for assistive tech");
if (!tippedHeat.includes("tokens")) throw new Error("the accessible label must keep the token count");
console.log("heatmap tooltip swap ok (title → aria-label + in-panel tip)");

// 小窗定位踩过的三个坑，逐条锁死：
// ① 挂错容器：挂 layer（侧栏底部 ~200px）会被 DSH 侧栏的 overflow 横向裁掉右半边
//    （用户实测："…160,22" 后面的数字整段消失）→ 面板开着必须挂进面板。
if (!source.includes("const container = panel ?? layer;") || !source.includes('mount: panel === null ? "layer" : "panel"')) {
	throw new Error("the tooltip must mount inside the panel while it is open (the sidebar clips the layer)");
}
if (!source.includes('tip !== null && tip.mount === "panel" && tipNode') || !source.includes('tip !== null && tip.mount === "layer" && tipNode')) {
	throw new Error("both tooltip mount points must exist");
}
// ② 夹取边界把 layer 宽度当容器：上下限会压成同一个数 —— 实测"不管悬停哪一格横向恒为 132px"。
if (source.includes("const width = Math.max(box.width, 264);")) {
	throw new Error("showTip must not clamp against the sidebar width alone (the tip gets pinned)");
}
// ③ 半宽被加了两次：showTip 先把半宽算进边界、useLayoutEffect 又加一次，小窗被推离格子 ~130px
//    （实测 offsetLeft 271/206/307，而状态里的正确值是 161.7/139/336.6）。半宽只在 fitTipX 里加。
if (!source.includes("function fitTipX(center, min, max, half)") || !source.includes("x: fitTipX(center, min, max, half),") || !source.includes("const x = fitTipX(tip.center, tip.min, tip.max, half);")) {
	throw new Error("the tooltip half-width must be applied exactly once, inside fitTipX");
}
if (source.includes("Math.max(tip.min + half, tip.max - half)")) {
	throw new Error("the tooltip half-width is being applied twice again");
}
// 滚动只收起小窗，**不做**任何降低清晰度的遮罩/渐隐（用户明确要求去掉：
// "不需要添加滚动降低清晰度的显示效果"）。曾经存在的 data-scroll mask 不得回归。
if (!source.includes("\t\t\t\t\t\t\t\tonScroll: hideTip,")) {
	throw new Error("the body scroll handler must dismiss the tooltip");
}
if (source.includes("data-scroll") || source.includes("mask-image") || source.includes("syncScrollHint")) {
	throw new Error("the scroll fade mask must stay removed (the user does not want dimming on scroll)");
}
// 小窗是绝对定位盒，夹取把它推出容器后可用宽度会变负、收缩宽度塌成"每个词一行"
// （实测一天详情被折成 4 行）。用 max-content 拿回宽度。
if (!source.includes('".usg_tip{position:absolute;z-index:40;pointer-events:none;width:max-content;max-width:260px;')) {
	throw new Error("the tooltip must size from its own content (width:max-content) or it gets squeezed");
}
// 夹取半宽必须是**实测**值：按"最宽 264px"保守假设会让首尾两列提前停住，看着仍像没跟随。
if (!source.includes("const half = tipHalfRef.current;") || !source.includes("const half = node.offsetWidth / 2;")) {
	throw new Error("the tooltip clamp must use the measured width, not the maximum assumed width");
}
// 面板 overflow:hidden：贴顶那一行的小窗要翻到下方，否则被切。
if (!source.includes('node.dataset.side = flip ? "below" : "above";') || !source.includes('".usg_tip[data-side=below]{transform:translate(-50%,0);animation-name:usg-tip-in-below}"')) {
	throw new Error("the tooltip must flip below the anchor when there is no room above");
}

// ---- P2：材质阶梯 / 语义色 / 令牌收敛 / 分层 / 无障碍 --------------------------
// 液态玻璃配方（拟态，见 拟态液态玻璃技术方案.md）：厚度来自边缘而非模糊。
// 阶梯 = 压暗 scrim 由外向内单调（越靠里的表面越实，保证数字可读）。
// 一份完整配方 = 四个 scrim + blur 在**同一条规则**里（`[^}]` 保证不跨规则匹配，
// 这样 @supports / reduced-transparency 的降级块不会被当成配方）。
const ladderPattern = /--usg-glass-scrim-1:(\d+)%[^}]*?--usg-glass-scrim-2:(\d+)%[^}]*?--usg-glass-scrim-3:(\d+)%[^}]*?--usg-glass-scrim-4:(\d+)%[^}]*?--usg-glass-blur:/g;
const ladders = [...source.matchAll(ladderPattern)];
if (ladders.length !== 3) throw new Error(`expected the dark ladder + both light copies (media query + data-usg-scheme), found ${ladders.length}`);
for (const ladder of ladders) {
	const scrims = [1, 2, 3, 4].map((index) => Number(ladder[index]));
	if (!(scrims[0] < scrims[1] && scrims[1] < scrims[2] && scrims[2] < scrims[3])) {
		throw new Error(`the material ladder must get more opaque inwards, got ${scrims.join(" < ")}`);
	}
}
// 关键参数：模糊必须做小（文档区间 4–8px；超过 10px 就退化成磨砂）。
const blurToken = /--usg-glass-blur:(\d+(?:\.\d+)?)px/.exec(source);
if (blurToken === null) throw new Error("missing --usg-glass-blur");
const blurRadius = Number(blurToken[1]);
if (!(blurRadius >= 4 && blurRadius <= 8)) throw new Error(`panel blur ${blurRadius}px must stay inside the 4-8px band`);
for (const fragment of [
	// ① 定向内阴影：左上受光边 / 右下弱反射 / 边缘渗光
	"inset 1px 1px 0 var(--usg-glass-lit)", "inset -1px -1px 1.5px var(--usg-glass-reflect)", "inset 0 0 26px var(--usg-glass-bleed)",
	// ② mask-composite 渐变描边（border 承载不了渐变，必须用 mask）
	"mask-composite:exclude", "-webkit-mask-composite:xor", "linear-gradient(160deg,var(--usg-glass-edge-1)",
	// ③ 贴顶柔光
	"mix-blend-mode:screen", "--usg-glass-topglow:radial-gradient(150% 88% at 50% -34%",
	"--usg-glass-shadow"
]) {
	if (!source.includes(fragment)) throw new Error(`missing liquid-glass layer: ${fragment}`);
}
// 受光边必须明显亮于弱反射（文档：弱反射 .10–.20 且"须明显低于左上，否则反物理"），
// 描边环则要上亮下暗（edge-1 亮于 edge-4）。
for (const index of ["1", "3"]) {
	const lit = new RegExp(`--usg-glass-lit-${index}:rgb\\(255 255 255 / (\\d+)%\\)`).exec(source);
	const reflect = new RegExp(`--usg-glass-reflect-${index}:rgb\\(255 255 255 / (\\d+)%\\)`).exec(source);
	if (lit === null || reflect === null) throw new Error(`missing edge-alpha tokens for tier ${index}`);
	if (Number(lit[1]) < Number(reflect[1]) * 2) {
		throw new Error(`tier ${index}: the lit edge (${lit[1]}%) must clearly exceed the reflection (${reflect[1]}%)`);
	}
}
const ringStart = /--usg-glass-edge-1:rgb\(255 255 255 \/ (\d+)%\)/.exec(source);
const ringEnd = /--usg-glass-edge-4:rgb\(255 255 255 \/ (\d+)%\)/.exec(source);
if (ringStart === null || ringEnd === null || Number(ringStart[1]) <= Number(ringEnd[1])) {
	throw new Error("the gradient border must stay brighter at the top-left than at the bottom-right");
}
// 材质规则不写 position：同特异性下会把 sticky 顶栏覆盖成 relative（文档踩过）。
const glassGroup = /\.usg_panel,\.usg_accountCard,[^{]*\{([^}]*)\}/.exec(source);
if (glassGroup === null) throw new Error("the shared glass-surface rule is missing");
if (glassGroup[1].includes("position:")) throw new Error("the material rule must not set position (sticky would lose)");
// 旧配方（大模糊 + 罩面 + 噪点）不许残留。
for (const gone of ["--usg-mat-", "feTurbulence", "usg-mat-grain", "26vw", "zoom:var(--usg-fs)", "--usg-fs"]) {
	if (source.includes(gone)) throw new Error(`the frosted recipe must be gone: ${gone}`);
}
// 固定显示比例：面板尺寸不随屏幕大小变化（用户要求"固定比例、各屏一致"），只保留窄窗口不溢出的兜底。
// 高度必须同时夹住视口：只写 74vh 时 844×390 视口里 bottom:128px + 288.6px 会把标题栏顶出屏幕
// （报告实测面板 y = -26.6px）。
for (const fragment of ["width:440px;max-width:calc(100vw - 24px);max-height:min(74vh,calc(100vh - 140px))"]) {
	if (!source.includes(fragment)) throw new Error(`missing fixed-size contract: ${fragment}`);
}
if (source.includes("max-height:74vh")) throw new Error("the panel height must stay clamped to the viewport, not a bare 74vh");
// 面板 + tooltip 各一条规则（含 -webkit- 前缀共 4 处）；卡片与内嵌块不再二次模糊。
const blurUses = (source.match(/backdrop-filter:blur\(var\(--usg-glass/g) ?? []).length;
if (blurUses !== 4) throw new Error(`backdrop-filter must stay on exactly two surfaces (panel + tooltip), found ${blurUses} declarations`);
if (!source.includes("@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px)))")) {
	throw new Error("the glass surfaces need a no-backdrop-filter fallback");
}
if (!source.includes("@supports not (mask-composite:exclude)")) throw new Error("the gradient border needs a plain-border fallback");
if (!source.includes("prefers-reduced-transparency:reduce")) throw new Error("reduced-transparency must be honoured");
// 交互：按压反馈 + 滚动收起小窗。滚动遮罩与刷新扫光都已按用户要求删除
// （"不需要添加滚动降低清晰度的显示效果"），两条反向断言防止回归。
for (const fragment of [".usg_cell:active", "onScroll: hideTip"]) {
	if (!source.includes(fragment)) throw new Error(`missing interaction contract: ${fragment}`);
}
if (/usg-sheen|data-refreshing/.test(source)) throw new Error("the refresh sheen must stay removed");
if (/data-scroll|mask-image|syncScrollHint/.test(source)) throw new Error("the scroll fade must stay removed");
if (/\.usg_glass[^,{]*(hover|active)/.test(source)) throw new Error("glass surfaces must not carry pointer-following highlight states");
// 右上角三个图标不再挂 DSH Tooltip（在固定定位的面板里会飘到热力图上方）。
if (source.includes("primitives.Tooltip")) throw new Error("the header icons must not use the primitives tooltip");
console.log("material ladder ok:", ladders.length, "recipes, blur", `${blurRadius}px,`, blurUses / 2, "blurred surfaces (panel + tooltip)");

// 死代码清掉；圆角/字重收敛（面板 16 / 卡片 12 / 控件 8，字重只留 600·700）。
for (const gone of ["usg_balanceCard", "card-strong", "border-radius:18px", "border-radius:14px", "font-weight:550", "font-weight:650"]) {
	if (source.includes(gone)) throw new Error(`dead or unconverged style still present: ${gone}`);
}
if (!source.includes("border-radius:16px") || !source.includes("border-radius:12px")) {
	throw new Error("the radius ladder (16 / 12 / 8) must be present");
}
console.log("token convergence ok (radius 16/12/8, weights 600/700, dead code gone)");

// 语义色：消费/用量/缓存三色令牌 + 统计格分类 + 构成色改走令牌。
for (const fragment of ["--usg-cost:#F0A64B", "--usg-token:#6E8BFF", "--usg-cache:#35C46A", "--usg-cost:#B4650F", '"data-kind": "cost"', '"data-kind": "token"', 'COMP_COLORS = { hit: "var(--usg-cache)"']) {
	if (!source.includes(fragment)) throw new Error(`missing semantic colour contract: ${fragment}`);
}
console.log("semantic colours ok (cost / token / cache tokens, COMP_COLORS on tokens)");

// A1 分层：最近 14 天与平台明细默认折叠，首屏只留账户卡 + 热力图。
for (const fragment of ["setRecentOpen", "setPlatformOpen", '"platform.modelsTitle"', '"aria-expanded": recentOpen', '"aria-expanded": platformOpen']) {
	if (!source.includes(fragment)) throw new Error(`missing A1 disclosure contract: ${fragment}`);
}
if (!source.includes("localDayTokens === null")) throw new Error("a past month must render — for today's tokens instead of 0");
if (!source.includes('"token.unsaved": "输入还没保存') || !source.includes('"token.unsaved": "Unsaved input')) {
	throw new Error("the unsaved-input hint must exist in both dictionaries");
}
console.log("A1 layering ok (two collapsed disclosures, past-month dash, unsaved hint)");

// B1：日历只占一个 Tab 停靠点（roving tabindex），方向键/Home/End 在日期间移动。
for (const fragment of ["tabIndex: cell.key === focusKey ? 0 : -1", "onCellKeyDown", "ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7", 'event.key === "Home" || event.key === "End"', "const position = positions.get(key)", "onMonthStep"]) {
	if (!source.includes(fragment)) throw new Error(`missing keyboard-grid contract: ${fragment}`);
}
const rovingMarkup = renderToStaticMarkup(react.createElement(MonthHeatmap, {
	heat,
	translate: (key) => key,
	selectedKey: null,
	onSelect: () => {},
	today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}));
const tabbable = (rovingMarkup.match(/tabindex="0"/g) ?? []).length;
if (tabbable !== 1) throw new Error(`the heatmap must expose exactly one tab stop, got ${tabbable}`);
console.log("keyboard grid ok (1 tab stop + arrow keys, Home/End, PageUp/PageDown)");

// B2：读屏替代 —— 小时图给摘要、余额与"更新于"用 status 播报。
for (const fragment of ['role: "img"', '"usage.hourSummary"', '"usage.ringLabel"', 'role: "status"', '"aria-live": "polite"']) {
	if (!source.includes(fragment)) throw new Error(`missing a11y contract: ${fragment}`);
}
// B3：平台区与日详情都有骨架，不再只靠一行文字。
if (!source.includes("detailLoading") || !source.includes("platform-skel-")) throw new Error("loading skeletons must cover the platform block and the day detail");

// ---- 审阅修复回归（2026-10-11 报告）-------------------------------------------
// ① 日详情必须走独立加载函数，并被手动刷新带上：它原来挂在一个依赖
//    [selectedDay, platformActive] 的 effect 上，同一天刷新月度数据时两个依赖都不变，
//    于是顶部总量涨了、按 API Key 与小时图还是旧值（报告实测新增日详情请求 0 次）。
for (const fragment of ["const loadDayDetail = react.useCallback", "if (selectedDay !== null && platformActive) requests.push(loadDayDetail(selectedDay, true))", "if (selectedDay !== null && platformActive) loadDayDetail(selectedDay, force)"]) {
	if (!source.includes(fragment)) throw new Error(`missing day-detail refresh contract: ${fragment}`);
}
if (source.includes("/api/usage-stats/platform/day?date=${selectedDay}`)")) {
	throw new Error("the day-detail request must go through loadDayDetail(date, force)");
}
// ② 五分钟轮询必须覆盖同一组平台数据（累计 + 最近 14 天 + 选中日日详情），
//    不能只重拉月用量（报告实测：推进五分钟后 /platform/total 新增 0 次请求）。
for (const fragment of ["const platformTick = react.useCallback", "loadPlatformTotal(force)", "loadRecentPlatform(force)", "window.setInterval(() => platformTick(), 300000)"]) {
	if (!source.includes(fragment)) throw new Error(`missing platform polling contract: ${fragment}`);
}
if (source.includes("window.setInterval(() => loadPlatform(platformMonth), 300000)")) {
	throw new Error("the five-minute timer must refresh the whole platform group, not just the month");
}
// ③ 减少动态效果必须排在所有基础动效之后（同特异性后者胜出）：它原来写在
//    .usg_body 基础动画之前，被整条覆盖（报告实测计算样式仍是 usg-body-in / 420ms）。
const reducedMotionIndex = source.lastIndexOf("prefers-reduced-motion:reduce");
const bodyAnimationIndex = source.indexOf("animation:usg-body-in");
if (reducedMotionIndex < bodyAnimationIndex) {
	throw new Error("the reduced-motion overrides must come after the base animations");
}
for (const fragment of [".usg_body,.usg_body[data-dir]{animation:none}", ".usg_skelBlock::after{animation:none}"]) {
	if (!source.includes(fragment)) throw new Error(`missing reduced-motion override: ${fragment}`);
}
// ④ 鼠标与键盘共用切月边界：PageDown 不能进未来月，切月后要把焦点交回日历
//    （报告实测：进入 2026-11 且 activeElement 变成 BODY）。
for (const fragment of ["const stepMonth = react.useCallback", "if (next > currentMonthKey()) return;", "onMonthStep(event.key === \"PageUp\" ? -1 : 1, key)", "const target = dayKeys.includes(focusRequest.key) ? focusRequest.key : dayKeys[0]", "focusCell(target)"]) {
	if (!source.includes(fragment)) throw new Error(`missing month-navigation contract: ${fragment}`);
}
if (source.includes("onMonthStep: (delta) => setPlatformMonth(shiftMonth(platformMonth, delta))")) {
	throw new Error("the keyboard month step must not bypass the shared stepMonth boundary");
}
// ⑤ 费用缺失不能显示成 ¥0.00：服务端给 costAvailable:false，客户端所有金额位改「—」。
for (const fragment of ["platform.costAvailable !== false", '"platform.costUnavailable"', '"platform.costUnavailable": "费用数据不可用（Token 数据不受影响）。"', '"platform.costUnavailable": "Cost data unavailable (token figures are unaffected)."']) {
	if (!source.includes(fragment)) throw new Error(`missing cost-availability contract: ${fragment}`);
}
// ⑥ 会话列表读取失败：服务端标 partial，面板必须说明"可能不完整"。
for (const fragment of ['setUsagePartial(payload.partial === true)', '"usage.partial"', '"usage.partial": "会话列表读取失败，统计可能不完整（已保留上次结果）。"', '"usage.partial": "Session listing failed — these numbers may be incomplete (last result kept)."']) {
	if (!source.includes(fragment)) throw new Error(`missing partial-data contract: ${fragment}`);
}
// ⑦ 累计是有界窗口：limited 时标签换「近 24 个月」并给出扫描区间。
for (const fragment of ["platformTotal.limited === true", '"usage.totalTokensLimited"', '"usage.scope"', "totalTokensLabel", "scopeNote"]) {
	if (!source.includes(fragment)) throw new Error(`missing cumulative-scope contract: ${fragment}`);
}
// ⑧ 同步取消：客户端每轮一个序号 + 取消标记，旧轮询不得改写新一轮状态。
for (const fragment of ["const syncSeqRef = react.useRef(0)", "syncSeqRef.current !== seq", "syncCancelledRef.current = true", "if (syncTimerRef.current !== null)"]) {
	if (!source.includes(fragment)) throw new Error(`missing sync-cancel contract: ${fragment}`);
}
console.log("review fixes contract ok (day refresh, unified polling, reduced motion, month bounds, cost/partial/scope, sync cancel)");

console.log("SMOKE TEST PASSED");
