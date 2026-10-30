# dsh-usage-stats

[![GitHub Release](https://img.shields.io/github/v/release/ray19156014597/dsh-usage-stats?display_name=tag&sort=semver&color=1f6feb)](https://github.com/ray19156014597/dsh-usage-stats/releases/latest)
[![CI](https://github.com/ray19156014597/dsh-usage-stats/actions/workflows/ci.yml/badge.svg)](https://github.com/ray19156014597/dsh-usage-stats/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-2da44e)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端提供 DeepSeek 账户余额、平台用量与 Token 用量分析。

DeepSeek balance, platform usage, and token-usage analytics for the DeepSeek Harness Web GUI (`dsh web`).

![dsh-usage-stats v0.8.1 interface preview](docs/images/usage-panel.svg)

> 展示图使用脱敏演示数据；插件不会把 API Key、Cookie、用量 Token 或上游原始响应发送到浏览器。

## 致谢 / Credits

本项目基于 [Ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)
（MIT，原插件基座）开发；DeepSeek 平台用量接口与「网页登录自动同步」移植自
[Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows)
（MIT）；功能设计启发自
[JayHome137/DeepSeekMonitor](https://github.com/JayHome137/DeepSeekMonitor)（macOS 原创版）。

开发过程中使用 [OpenCLI](https://github.com/opencode-ai/opencli) 辅助探测与优化平台
用量接口的参数细节。

> 本插件为非 DeepSeek 官方产品，与 DeepSeek 官方无关，仅用于学习与研究目的；平台接口可能随官方调整而变化，
> 不保证长期可用。API Key 与用量 Token 属于敏感凭据，请自行妥善保管。

## 一眼看懂 / At a glance

| | 能力 | 说明 |
| --- | --- | --- |
| 💳 | 账户卡片 | DeepSeek 余额与平台用量合并为**同一张卡**，一次呈现账户全貌 |
| 📈 | DeepSeek 平台用量 | 本月/今日消费、按模型、**按 API Key** 的 Token/请求/缓存命中/费用明细（需网页用量 Token）；每日用量与本地一致地按 **GMT+8** 展示，位于 Token 用量模块之前 |
| 📊 | Token 用量分析 | 今日、本月、累计、缓存命中率、月历热图，以及按日期/模型下钻。累计由服务端按月回扫（最多 24 个月、单次扫描 15 秒预算）；未覆盖到用量起点时标签显示为**“近 24 个月”**并给出实际统计范围，不把有界窗口说成全部历史 |
| 🔄 | 后台刷新 | 服务端启动即刷新，之后每五分钟更新余额与本地 Token 聚合；面板打开期间“本月 / 累计 / 最近 14 天 / 选中日详情”按同一周期一起刷新；聚合结果在 60 秒窗口内复用，多个面板/标签页不会重复折叠 |
| 🧊 | 毛玻璃材质 | 每档表面 = 底色 + 方向性内阴影成形（上亮下暗的厚度感）+ 渐变描边环 + 顶边镜面高光，四级阶梯（面板 < 卡片 < 内嵌块 < 浮层，越里越实）；深色底色 40% / 浅色 62%，模糊 6px/4px、饱和度 1.9/1.4，浅色档不使用白色罩面，也不再叠噪点（v3 起移除）；只有真正压在页面内容上的面板与 tooltip 才用 `backdrop-filter`（其余表面不再重复合成）；不支持该属性或开启“减少透明度”时自动退回接近不透明的表面 |
| 📐 | 固定显示比例 | 面板在各显示器上保持同一尺寸（440px 宽、最高 74vh，同时不超过视口高度减去底部锚点与顶部留白），不随屏幕大小放大缩小，只保留“窄窗口不溢出”的兜底；布局随内容自适应：折叠态一屏放下，展开态才滚动 |
| ⌨️ | 顺手交互 | **首屏一屏放下**：余额 + 6 格统计 + 当月日历，最近 14 天/平台模型/按 API Key 折叠在下方；侧边栏渲染即预热数据，首次打开直接出热力图；面板自徽标处展开、关闭带退场动效；下钻视图带方向推入，`Esc` 逐级返回；刷新按钮转圈并把“更新于 hh:mm”换成“刷新中…”（右上角三个图标不带悬浮气泡，语义由 `aria-label` 承载）；热力图格子用面板自绘 tooltip，支持**方向键/Home/End/PageUp/PageDown** 在日历里移动，整块日历只占一个 Tab 停靠点 |
| 🎨 | 语义化配色 | 消费走琥珀、Token 走蓝、缓存命中走青绿：6 格统计条按类别着色，日详情的环形图与占比条用同一套令牌（不再是“一片蓝”） |
| 🪟 | 统计弹层玻璃材质 | DSH 输入框统计条（轮次/tok/s、Token 用量、上下文占用）和每轮「用量 X tok」点开后的弹层，套用插件同款液态玻璃（底色 + 方向性内阴影 + 淡描边 + 顶边高光，4px/1.9 模糊；描边与受光取淡档）；**统计条本身保持 DSH 原样**，不改颜色、字体或间距 |
| 💰 | 费用统计（本轮 / 会话） | 统计条 Token 用量处就地追加「· ¥80.05」（会话总花费，含 subagent）；「本轮用量」弹层加「本轮费用」，「Token 用量」弹层加「会话总费用」。按官方价目逐请求折算（含峰谷与历史调价），子代理按创建时间归属到轮次 |
| ⏱️ | 高峰 / 空闲计费时段 | 「账户与用量」标题行右侧显示状态点 + **高峰价/空闲价** + 距下一次切换的倒计时；悬停显示高峰窗口、当档 Flash/Pro 价与周末/节假日原因。规则与费用估算共用同一套价目表；**法定节假日自动同步（周更，离线回退内置表）** |
| 🧾 | 侧栏徽标（今日） | 侧栏「用量/余额」右侧同时显示**今日消费 ¥3.43** 与**今日 Tokens 71,545,178**；金额取平台口径（与账户卡同源），不可用/为零时只显示 Tokens；rail 图标态放进 tooltip |
| 🔒 | 本机安全边界 | 九个端点仅接受回环请求；凭据只在服务端解析并发往校验后的 DeepSeek 地址 |

界面支持中文和英文。浏览器只请求 DeepSeek 账户与本地聚合数据；后台刷新与面板是否打开无关。侧边栏一渲染就会静默预热账户、Token 聚合与平台用量，所以面板首次打开即可显示完整内容；若在预热完成前打开，才短暂显示骨架占位。手动刷新会强制服务端重新聚合 Token 用量，并更新余额与平台用量。动效遵守系统的“减少动态效果”设置；小时用量图与环形图附带读屏摘要，余额与“更新于”通过 `aria-live` 播报。

## 快速安装 / Quick start

需要 DeepSeek Harness `web` profile（`@deepseek-ai/dsh >= 0.1.0-rc.6`）。

```bash
dsh plugin --profile web add "github:ray19156014597/dsh-usage-stats"
```

然后重启已经运行的 `dsh web`，并在浏览器中硬刷新。侧边栏底部会出现“用量/余额”（Usage/Balance）入口。

升级或卸载：

```bash
dsh plugin --profile web update dsh-usage-stats
dsh plugin --profile web remove dsh-usage-stats
```

<details>
<summary><strong>兼容安装器：无法使用 dsh plugin 时展开</strong></summary>

PowerShell、命令提示符和 macOS/Linux 终端使用同一条命令：

```bash
npx --yes github:ray19156014597/dsh-usage-stats
```

安装器会自动识别 profile 布局：

- **dsh ≥ 0.1.7**（profile 由 pnpm 管理）：把运行文件复制到 `~/.dsh/profiles/web/node_modules/dsh-usage-stats`，在 `profiles/web/package.json` 里登记 `dsh.profile.bundles` 与 `file:` 依赖（插件由此成为 profile bundle，客户端半才会被下发），并清掉 `profiles/web/cordis.patch.yml` 里遗留的手工 insert —— 否则同一个入口 id 会被挂载两次。
- **dsh < 0.1.7**：复制到 `~/.dsh/profiles/node_modules/dsh-usage-stats`，并幂等追加 Cordis entry。

重复运行即可更新，不会重复追加配置。设置了 `DSH_HOME` 时使用该目录。

`dsh plugin` 与 `npx` 是两条独立安装路径，请选择其中一种；不要同时保留手工 Cordis entry 和 bundle 注册，否则会重复挂载。

```bash
# 预览，不修改文件
npx --yes github:ray19156014597/dsh-usage-stats --dry-run

# 检查现有安装
npx --yes github:ray19156014597/dsh-usage-stats --check

# 安装但不修改 Cordis patch
npx --yes github:ray19156014597/dsh-usage-stats --no-enable
```

无法使用 `npx` 时可从源码运行 `node scripts/install.mjs`。

</details>

## 支持的账户类型 / Providers

插件只对接 DeepSeek 官方账户：余额查询需要 API Key，Token 用量统计不需要额外凭据。账户查询使用唯一适配器 `deepseek-balance`。

| Provider / adapter | 模式 | 默认凭据 | 上游接口 |
| --- | --- | --- | --- |
| DeepSeek | 余额 | `llm-deepseek` 的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`） | `/user/balance` |

未配置 API Key 时账户卡片显示“未配置”，不会猜测余额；Token 用量统计不受影响。

## 凭据与配置 / Configuration

凭据由 Harness 从 `~/.dsh/.credentials.yaml` 解析。安装器不会读取、创建或修改该文件。不要把真实 Key、Cookie 或用量 Token 提交到 Git、公开 issue，或粘贴给编码 Agent。

插件的连接信息读取 Harness 的 `llm-deepseek` settings 命名空间（API Key 引用与 base URL），缺失时回退到 `DEEPSEEK_API_KEY` 与 `https://api.deepseek.com`。Cordis config 只接受一个字段 `usageTokenRef`（平台用量 Token 的凭据引用，默认 `DEEPSEEK_USAGE_TOKEN`）。

### DeepSeek 余额

```yaml
# ~/.dsh/.credentials.yaml
DEEPSEEK_API_KEY: sk-your-key-here
```

余额来自 `GET /user/balance`，账户卡片显示剩余额度、已用与总额度，并按剩余比例给出 `normal / warning / critical` 状态（默认 30% / 10%）。服务端启动即查询，之后每五分钟刷新一次。

### DeepSeek 平台用量（余额之外的消费与 Token 明细）

DeepSeek 官方只公开余额接口，没有账户级用量 API。插件移植了
[DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows)
的方案：用量数据来自 `platform.deepseek.com` 的网页接口
（`/api/v0/usage/by_api_key/amount` 与 `/api/v0/usage/by_api_key/cost`），需要**用量 Token**——
它与 API Key 不同，是登录 platform.deepseek.com 后在控制台执行
`JSON.parse(localStorage.userToken).value` 得到的会话凭据：

```yaml
# ~/.dsh/.credentials.yaml
DEEPSEEK_API_KEY: sk-your-key-here      # 余额接口
DEEPSEEK_USAGE_TOKEN: eyJ...            # 平台用量接口（localStorage.userToken）
```

用量 Token 会过期；查询失败时按上述方式重新获取即可。该 Token 只在服务端
通过 credentials seam 解析，不会进入浏览器响应或插件缓存。自定义引用可在
Cordis config 中设置 `usageTokenRef`。

**也可以在界面里配置**：打开用量面板，点标题栏的 ⚙ 设置按钮（或平台用量
区块未配置提示旁的“配置用量 Token”按钮），两种方式任选：

- **方式一：网页登录自动同步**（推荐，移植自 DeepSeekMonitorWindows）——
  点击后服务端拉起系统 Edge/Chrome 窗口打开 platform.deepseek.com，登录
  成功后自动捕获、验证并保存用量 Token（复用 DSMW 的 fetch/XHR 钩子 +
  `localStorage.userToken` 轮询），随后立即刷新平台用量并显示本月消费。
  登录状态保存在 `~/.dsh/usage-stats/browser-profile`，下次同步无需重新登录。
- **方式二：手动粘贴**——按页面指引在控制台执行
  `JSON.parse(localStorage.userToken).value` 后粘贴保存。

保存/清除后平台用量数据立即同步更新。Token 保存在
`~/.dsh/storages/usage-stats-platform.json`（权限受限），服务端优先使用
credentials 文件中的引用，其次才用面板保存的值。未配置时面板显示获取指引，
不影响其余功能。自动同步依赖本机 Edge/Chrome（CDP，无新增 npm 依赖）；
找不到浏览器时会提示改用方式二。

## 使用 / Usage

1. 点击侧边栏“用量/余额”。
2. 「账户与用量」显示 DeepSeek 账户卡：余额与平台用量合并为**同一张卡**（细分隔线连接）：余额 → 平台用量（月份切换、本月消费、今日消费、API 请求数与按模型明细）。
3. 其下方的「Token 用量」显示今日/本月/累计与缓存命中率，月历热力图在平台用量配置后显示平台获取的每日用量（标题旁标注数据源），未配置时回退显示本地用量，点击日期可下钻当日明细；面板最末尾是**可折叠的「按 API Key」**明细（默认收起，可点击展开/收起）。
4. 使用热图的 `‹` / `›` 切换月份；点击日期查看当天明细：本地日显示 `provider/model` 明细，平台日显示逐小时分布与按 API Key 明细。
5. 标题栏刷新会更新 Token 用量、余额与平台用量。

“最近 14 天”按本地日历计算，只显示窗口内存在用量的日期；未来时间戳不会计入。本地会话用量按 `provider/model` 归集，同一模型经由不同 provider 路由时会分别统计。

## 统计弹层玻璃材质 / Liquid-glass stat dialogs

插件只给**点开的弹层**换材质，**输入框下方的统计条外观保持 DSH 原样**（不改颜色、字体、间距、图标）：

- 覆盖范围：统计条三颗药丸点开的「会话统计」「Token 用量」「上下文占用」弹层，以及每条已完成回复下方「用量 X tok」点开的「本轮用量」弹层。
- 材质沿用插件面板同一套配方，但按“轻量”调过一档：`backdrop-filter: blur(4px) saturate(1.9)` 的底色 + 方向性内阴影（上亮下暗厚度感）+ **淡渐变描边环** + 顶边镜面高光；深色 40% 底色 / 浅色 62%，浅色档另有一套更淡的描边与阴影。
- 主题跟随 DSH 主题服务（而非系统偏好）：客户端把当前 scheme 写到 `html[data-usg-scheme]`，弹层用 `html[data-usg-scheme=dark|light]` 选令牌；拿不到主题服务时退回 `prefers-color-scheme`。
- 只改材质，不改 DSH 的 DOM/类名/内容；弹层定位与点击行为仍由 DSH 负责，无 `backdrop-filter` 或开启“减少透明度”时退回接近不透明的表面。
- 浏览器控制台无报错；插件热重载时样式表会原地更新（不会残留上一版规则）。

## 费用统计 / Cost per turn & per session

在 DSH 原生界面上就地补两处金额，**不重绘统计条、不加新药丸**：

- **统计条**：Token 用量药丸末尾追加 `· ¥80.05`（与原生药丸同字体/同色/同分隔符，仅在金额就绪后出现；悬停提示写明“会话总费用 · 按官方价目估算”）。金额是**当前会话总花费，含全部 subagent 子会话**。
- **本轮用量弹层**：在 DSH 自己的 `dl` 末尾插一行「本轮费用」= 该轮主会话消耗 + 该轮创建的子代理会话（按子会话 `createdAt` 落在哪一轮的时间窗归属）。弹层顶部原有的 Token 明细不变。
- **Token 用量弹层**：同样插一行「会话总费用」，与统计条金额一致。

口径与实现：

- 逐请求按官方价目表折算（缓存命中 / 未命中 / 输出；缓存写入按未命中价），覆盖 2026-08-17 峰谷上线、08-23 周末全天空闲、09-10 12:00 Flash 降价、10-17 新模型同价，09-19 起调休/节假日按空闲；峰谷按请求时间（北京时间）判定。
- 宿主端 `GET /api/usage-stats/session?sessionId=…` 返回 `total`（会话合计）、`main`、`subagents`、`models` 与 **`turns`**（逐轮费用，含 `mainCost` / `subagentCost` / `totalCost`）。逐会话增量折叠缓存，轮询开销只与新增事件有关。
- 客户端只做“取数 + 在 DSH 既有节点上补数字”：`MutationObserver` 监听 DSH 重渲染并补回被替换的节点；会话切换、token 投影变化（600ms 防抖）立即取数，页面可见时每 20s 轮询一次（子代理用量不进父会话投影）。
- 估算而非账单：实际扣费以 platform.deepseek.com 账单为准；用于核对时，整日仅含本会话的日期与平台账单完全一致。

## 高峰 / 空闲计费时段 / Peak & idle price indicator（v0.9.2）

指示器**不占独立模块**：它嵌在「账户与用量」标题行的右侧空白处，与标题同一行、同一套 11px tertiary 排版，只在最左侧多一个状态圆点：

- 圆点 + 状态：**高峰价**（琥珀）/ **空闲价**（绿）/ **平价**（2026-08-17 前的价目表）；
- 状态右侧倒计时：`距空闲 1h17m` / `距高峰 2d 10h`，跨过切换点后本地立即翻转，不依赖下一次轮询；
- 悬停整条：当档 Flash / Pro 价（命中/未命中/输出，元 / 百万 tokens）、高峰窗口（09:00–12:00、14:00–18:00，北京时间）、“周末全天空闲 / 节假日全天空闲”的原因，以及节假日日历的同步日期。

数据来自新端点 `GET /api/usage-stats/price-period`（回环 only、GET only、不需要任何凭据）：宿主端用与费用估算**完全相同**的 `lib/cost.js` 规则算出当前时段、当前价格行与下一次切换时刻（30 秒缓存；面板 30 秒轮询、15 秒刷新倒计时）。规则覆盖 8/17 峰谷上线、8/23 周末全天空闲、9/10 12:00 Flash 降价、10/17 同价、节假日/调休安排；工作日 09:00–12:00 与 14:00–18:00 为高峰，其余为空闲。

**节假日自动同步（v0.9.2）**：`lib/holidays.js` 会在插件启动后、以及每 12 小时把当前年 ±1（含上一年，供历史费用估算）的法定节假日从公开日历接口同步到 `<DSH_HOME>/storages/usage-stats-holidays.json`，再喂给 `cost.js` 的 `setHolidayCalendar()`。因此日历、指示灯与费用估算**共用同一份自动更新的假日表**：

- 数据源按顺序尝试 `timor.tech` → `api.jiejiariapi.com`；只发送年份、不带任何凭据；
- 当前年及下一年每 7 天刷新一次（官方调休公告随时可能更新），更早年份视为不变、只取一次；
- 无网络/两源都失败时沿用本地缓存；再退到内置 2026 假日表——**只会漏掉"新公告"，不会丢掉已知假日**；
- 同步结果（来源/日期/假日数）随 `price-period` 返回，悬停提示里能看到"节假日日历自动同步于 …"。

不修改输入框统计条，也不影响 DSH 原生弹层；指示器只做只读展示，窄宽下倒计时自动省略，状态文字始终可见。

## 侧栏徽标：今日金额 + 今日 Tokens（v0.9.2）

侧栏底部的「用量/余额」徽标不再只显示今日 token：右侧一组数字同时给出**今日消费金额**与**今日 Tokens**，例如 `¥3.43  71,545,178`。

- 金额取平台「今日消费」（`platform.days` 的当日 `totalCost`，与账户卡同源，非本地估算）；颜色用插件费用色（琥珀），Tokens 保持 tertiary，字号 11/12px。
- 只在平台日数据可用且金额 > 0 时显示金额；平台未配置或费用接口异常时只显示 Tokens，**不会显示 ¥0.00**。
- 徽标始终跟"今天"，不跟当前查看的月份：正常取当月平台日数据；翻到其它月份时用最近 14 天的平台缓存（`recentPlat`）兜底；平台不可用才回退本地当日合计。
- rail（窄侧栏图标态）不显示数字，tooltip 同时给出「今日 Tokens … · 今日消费 …」。
- 布局：金额与 Tokens 组成右对齐的一组（`margin-left:auto`），窄侧栏优先省略标签文字而不是数字。
- **修复（v0.9.2）**：徽标读取今日数据时误用了不存在的 `today` 变量（`todayKey()` 的局部变量只存在于回调/resize 作用域）。只要平台数据可用（`platformActive` 为真）就会抛 `ReferenceError`，导致整个面板组件被 React 错误边界卸载、侧栏徽标消失——现已改为直接调用 `todayKey()`。

## 累计 Tokens 口径修复（v0.9.1，2026-10-24）

- **现象**：插件「累计 Tokens」显示 3.2B，桌面独立版同位置显示 11.2B（本月/今日/消费/API 请求两边一致）。
- **根因**：插件累计走平台逐月回扫；扫到账号数据窗口以外（2026-02 及更早）时上游返回非 JSON，整条扫描抛错 → 路由 502 → 客户端**静默回退本地会话累计**，但标签仍是「累计 Tokens」。桌面独立版显示的是平台累计，所以它是对的；3.2B 只是本机 DSH 会话从 2026-08-15 起的合计。
- **修复**：
  - 宿主：回扫遇到旧月份不可读（`invalid-response` / `unsupported` / `unavailable`）时**停止回扫并返回部分结果**（`partial` / `stoppedAt` / `complete`），不再让整个累计失败；auth / 限流 / 参数错误仍然照常报错。预算用尽也统一标 `limited`。部分结果只缓存 60 秒，便于上游恢复后立刻重算。
  - 客户端：平台累计不可用时标签改为**「本地累计」**并附口径说明；部分扫描但已覆盖全部用量月时仍显示「累计 Tokens」，并注明「累计自 {oldest} 起」；未覆盖时显示「累计（截至 {to}）」并给出统计范围。
- **验证**：用同一 usageToken 真实回扫 → 2026-06~10 共 5 个有用量月份，`11,220,605,108` tokens（10 月仍在增长，与桌面版 11,210,377,650 的差异来自刷新时间），`partial: true`、`complete: true`、`limited: false`；与桌面版口径一致。
- **测试**：平台单测新增 tolerant-history / auth-still-throws / budget-limited 三个用例；smoke 增加对应 i18n 键与源码标记断言。

## Agent 友好安装 / Agent-friendly installation

<details>
<summary><strong>复制给 Codex、Claude Code 或其他本地编码 Agent</strong></summary>

```text
Install or update dsh-usage-stats from:
https://github.com/ray19156014597/dsh-usage-stats

Constraints:
- Resolve DSH_HOME from the environment; otherwise use ~/.dsh.
- Do not read, print, edit, or request .credentials.yaml, cookies, or any API key.
- Do not expose the plugin through a reverse proxy.
- Do not restart or terminate an existing dsh process without asking me.

Procedure:
1. Confirm node, npx, and dsh are available.
2. Prefer `dsh plugin --profile web update dsh-usage-stats` when already installed; otherwise use `dsh plugin --profile web add "github:ray19156014597/dsh-usage-stats"`.
3. If unavailable, use: npx --yes github:ray19156014597/dsh-usage-stats
4. Do not combine bundle installation with an existing manual dsh-usage-stats Cordis entry.
5. For npx, require a verified package plus exactly one Cordis entry (dsh < 0.1.7) or exactly one dsh.profile.bundles entry (dsh >= 0.1.7), then run again with --check. The installer prints which layout it detected.
6. Report the installation path and resolved profile paths.
7. If dsh web is running, report that a restart is needed and stop.

Optional account setup (never handle secret values yourself):
- DeepSeek balance reuses DEEPSEEK_API_KEY.
- The platform usage token is set through the panel settings page or a usageTokenRef credential reference.
- Never ask me to paste a key, usage token, or browser cookie into chat.
```

只获准检查而不能修改时运行：

```bash
npx --yes github:ray19156014597/dsh-usage-stats --check
```

安装器退出码：未知参数返回 `2`；文件、版本或配置验证失败返回非零；成功时输出已验证版本、安装目录和 patch 路径。Agent 无需自行解析或重写 YAML。

</details>

## 隐私与安全 / Privacy & security

- API Key、Cookie 与用量 Token 不会进入浏览器响应、插件缓存或日志。
- 余额请求固定使用 HTTPS、不跟随重定向，响应体上限为 1 MiB；上游地址禁止内嵌 username/password，凭据只在服务端按 credential ref 注入请求头。
- 余额请求在发凭据前会校验域名的全部 IPv4/IPv6 解析结果并固定连接地址，防止 DNS rebinding 绕过私网限制。唯一例外是 **本地代理的 fake-ip 占位地址**（`198.18.0.0/15`，Clash / Mihomo / Surge / iKuuu 等客户端对所有域名都返回这一段的地址，再按 SNI 自行转发）：它无法指向内网服务，因此按解析结果放行并照常固定连接；但把该地址直接写进配置（`https://198.18.0.5`）仍然拒绝。域名解析到真正的内网地址时按"暂时不可用"处理，保留上一次余额并显示解析结果。
- 九个端点仅接受回环请求，并同时校验 peer socket 与 Host；其中七个只接受 `GET`，`platform/token` 与 `platform/sync` 额外接受 `POST`/`DELETE`。有副作用的请求（保存/清除 Token、启动或取消登录同步）还会校验同源 `Origin`、`Sec-Fetch-Site`，并要求带 body 的请求使用 `application/json`；不带 `Origin` 的本机工具调用（curl、PowerShell）保持放行。支持 IPv4、IPv4-mapped IPv6 和 `[::1]:port`。
- 用量缓存 `~/.dsh/storages/usage-stats-cache.json` 只保存聚合 Token、会话 id、不透明 revision 与折叠游标，不保存提示词、回复或文件路径。
- DeepSeek 平台用量 Token 只在服务端解析并用于请求 `platform.deepseek.com`，平台用量结果按月份在内存中缓存五分钟（历史月份 30 分钟），不落盘、不出现在响应中；缓存按凭据身份隔离，换 Token 或清除 Token 会立即失效月/日/累计缓存。
- 节假日日历同步（v0.9.2）会访问公开日历接口 `timor.tech` / `api.jiejiariapi.com`，只发送年份（`/<year>`），不携带任何凭据、账户信息或本地用量；结果只含日期字符串，缓存在 `~/.dsh/storages/usage-stats-holidays.json`。离线时完全不影响指示灯与费用估算（使用缓存 + 内置 2026 表）。
- 会话列表读取失败时不会把“读不到”当成“没有会话”：插件保留上一次的聚合缓存、跳过清理，并在响应里标记 `partial: true`，面板会显示“统计可能不完整”。
- 平台费用接口返回 200 但缺少费用结构时，响应带 `costAvailable: false`，面板把所有金额位显示为“—”，不会把“费用不可用”显示成 ¥0.00。

本机反向代理会让插件看到代理自身的回环地址。请勿把端点经反向代理暴露到局域网或公网；确需代理时必须在代理层增加可靠认证与访问控制。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 正确性与数据口径 / Correctness

统计值来自 `assistant/chunk` 或 `assistant/message` 中 provider-reported `usage`，不是本地估算。相同 turn/step 的后续样本会替换旧样本，并按 `provider/model` 归集。

- **时区口径**：平台用量与本地会话用量统一按 **GMT+8** 展示。平台取数使用官网用量页同一套接口（`/api/v0/usage/by_api_key/amount|cost`，`start/end` 为 GMT+8 日的 epoch 秒、`tz=28800`）：月视图按 `bucket=86400` 取每日数据，日视图按 `bucket=3600` 取逐小时数据。若该私有接口异常，自动回退旧的 `usage/amount|cost`（UTC 日、无按 API Key 维度）并保持面板可用（接口响应带 `source` 标记），此时平台日与本地 GMT+8 可能相差一天。
- 活跃会话只处理新追加事件。
- 持久化会话使用不透明 revision；未变化时不重复读取日志。
- seq 缺口、日志重写或 live/persisted 切换时完整重折叠该会话。
- 聚合采用 single-flight，并在同一临界区原子保存缓存。
- `validate:live` 会逐会话比较 raw artifact、`session.history`、插件端点与官方 token projection；缺文件或不一致会返回非零。
- **费用估算**：逐 `usage` 样本（同 turn/step 替换）× 官方价目表。价目按日期分段：2026-08-17 00:00 前平价（V4-Flash 0.02/1/2、V4-Pro 0.025/3/6 元/百万 tokens），08-17 起峰谷（Flash 空闲 0.05/1.5/4.5、高峰翻倍；Pro 空闲 0.15/4.5/13.5、高峰翻倍），08-23 00:00 起周末全天空闲，09-10 12:00 起 Flash 新价（空闲 0.02/1/4、高峰翻倍；旧模型名同价），10-17 新模型价格不变；09-19 起调休上班周末与法定节假日按空闲。峰谷按请求时间（北京时间）判定。逐轮费用 = 该轮样本费用 + 创建时间落在该轮时间窗内的子代理会话费用。估算已与平台逐日账单核对：整日仅含本会话时完全一致。

## API

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/api/usage-stats/usage?refresh=1` | 按日期/provider/model 聚合的 Token 与缓存命中率；结果在 60 秒窗口内复用，`refresh=1` 强制重新聚合；会话列表读取失败时带 `partial: true`（保留上次聚合） |
| `GET` | `/api/usage-stats/session?sessionId=…` | 该会话**连同全部 subagent 子会话**的估算费用：`total`（Token 构成、缓存命中率、请求数、`peak`/`idle`/`flat` 的 Token 与金额、按模型）、`main`、`subagents`（数量/Token/金额/逐子会话）、`turns`（逐轮 `mainCost`/`subagentCost`/`totalCost`）；未知会话 `404`，缺少参数 `400` |
| `GET` | `/api/usage-stats/account?refresh=1` | DeepSeek 余额快照；`refresh=1` 强制刷新上游；连续瞬时故障时沿用最后一次成功余额并带 `stale: true` |
| `GET` | `/api/usage-stats/platform?month=&year=&refresh=` | DeepSeek 平台用量（模型/按日 Token 明细与消费）；`refresh=1` 强制刷新；费用结构缺失时 `costAvailable: false` |
| `GET` | `/api/usage-stats/price-period` | 当前计费时段：`period`（peak/idle/flat）、`reason`（peak-window/off-window/weekend/holiday/flat）、`windows`、`prices.flash/pro`（命中/未命中/输出，元每百万）、`next`（下一次切换的时刻与目标时段）、`calendar`（节假日日历来源/同步时间/年份/假日数）；只读、无需凭据 |
| `GET` | `/api/usage-stats/platform/total?refresh=1` | 平台累计 Token 总量（有界窗口）：`scannedMonths` / `range` / `limited` 说明扫描范围与完整性；`refresh=1` 强制重扫各月 |
| `GET` | `/api/usage-stats/platform/day?date=YYYY-MM-DD&refresh=1` | 某一天的逐小时用量与按 API Key 明细；`refresh=1` 绕过五分钟缓存 |
| `GET`/`POST`/`DELETE` | `/api/usage-stats/platform/token` | 用量 Token 设置（状态/保存/清除；Token 本身永不返回浏览器） |
| `GET`/`POST`/`DELETE` | `/api/usage-stats/platform/sync` | 网页登录自动同步（开始/状态/取消；按需拉起系统浏览器窗口） |

非 GET 返回 `405`（token 与 sync 路由允许 GET/POST/DELETE），非回环请求或跨站 `Origin`/`Sec-Fetch-Site` 返回 `403`，非 JSON 请求体返回 `415`；所有响应均为 JSON 并带 `Cache-Control: no-cache`。

## 开发与验证 / Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

`npm test` 完全离线，覆盖 bundle、客户端渲染与请求竞态、服务端安全边界、DeepSeek 余额适配器、平台用量解析、网页登录自动同步、缓存、**费用引擎（价目分段 / 峰谷 / 替换语义 / 逐轮归属）**、**计费时段指示（工作日/午休/周末/节假日/边界分钟/平价时代）**、**节假日同步（解析/缓存/双源回退/过期策略）** 和安装器幂等性。只想跑费用引擎时用 `npm run test:cost`；只跑时段规则用 `npm run test:price`；只跑节假日同步用 `npm run test:holidays`。真实数据验证需先运行 `dsh web`：

```bash
npm run validate:live
node scripts/check-balance.mjs
```

所有服务端脚本均遵循 `DSH_HOME`。`check-balance.mjs` 可能显示真实余额，不要把输出粘贴到公开 issue。

**运行时要求**：Node.js **≥ 20**（服务端半用到 `Object.hasOwn`、`node:` 前缀导入与 ESM；CI 在 Node 24 上运行）；安装与网页登录自动同步面向 Windows（Edge/Chrome 路径探测），其他平台可手动粘贴 Token。CI 目前只有 `ubuntu-latest` 一个作业，Windows 路径与文件替换的自动化覆盖尚未加入。

## 兼容性与致谢 / Compatibility & credits

当前版本为 `0.8.1`。插件依赖 Harness 客户端模块加载器、Cordis 服务与 session persistence；Harness 预发布接口变化时可能需要同步适配。热力图色阶跟随 `theme` 服务的主题快照（`theme/change`），拿不到该服务时回退到系统的 `prefers-color-scheme`。

- [Joyi-code/DeepSeekMonitorWindows](https://github.com/Joyi-code/DeepSeekMonitorWindows)：移植 DeepSeek 平台用量方案（用量 Token、平台用量接口解析与模型明细）。

本项目重新实现账户快照协议与面板 UI，不复制参考项目界面。

## License

[MIT](LICENSE)
