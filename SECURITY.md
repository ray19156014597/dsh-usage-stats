# Security Policy

## Reporting a vulnerability

Please use this repository's private vulnerability-reporting form under the GitHub **Security** tab when it is available. If it is unavailable, open a minimal issue asking the maintainer for a private contact channel; do not include exploit details in that issue.

请优先通过 GitHub **Security** 页面中的私密漏洞报告功能联系维护者。如果该入口不可用，请只创建一个不含利用细节的简短 issue，请求私下沟通渠道。

Never include DeepSeek API keys, credentials files, session contents, raw logs, or unredacted balance data in a report. Revoke any credential that may already have been exposed.

报告中不要附带 DeepSeek API key、凭据文件、会话内容、原始日志或未脱敏余额。已经暴露的凭据应立即吊销。

## Scope

Security fixes target the latest version on the default branch. The seven HTTP endpoints are designed for direct loopback use only; exposing them through a reverse proxy is outside the supported security model unless the proxy adds authentication and access control.

This plugin is DeepSeek-only: the official balance API (`https://api.deepseek.com/user/balance`, authenticated by `DEEPSEEK_API_KEY`) plus the platform web-usage interface on `platform.deepseek.com` (authenticated by a usage token captured from `localStorage.userToken`). There is no multi-provider monitor configuration.

### Endpoint fence

Every endpoint requires a loopback peer socket address and a loopback `Host` header. Five of them are `GET`-only; `platform/token` and `platform/sync` additionally accept `POST`/`DELETE`. A loopback peer alone is not enough for the routes that write or act: a cross-site page running in the user's own browser also reaches `127.0.0.1`, so those routes additionally require

- a same-origin `Origin` header when one is present (a request without `Origin` — curl, PowerShell, native clients — is allowed by design and is the documented local-tool path),
- `Sec-Fetch-Site` to be absent, `same-origin`, or `none`,
- any request body to be `application/json` (form content types are exactly what a cross-site page can post without a preflight).

Failing requests get `403` (foreign origin/site) or `415` (non-JSON body) before the body is read.

### Credentials

Tokens are resolved server-side only (`DEEPSEEK_USAGE_TOKEN`, the configured `usageTokenRef`, or the token saved through the panel into `~/.dsh/storages/usage-stats-platform.json` with mode `0600`). They never reach the browser, the plugin cache files or the logs. Platform response caches are invalidated whenever the resolved credential changes, so one account's cached figures can never be served for another; the credential value itself is compared in memory only and never becomes a cache key or a log line.

### Account balance

Balance requests are HTTPS-only, do not follow redirects, cap the response body at 1 MiB, and reject embedded credentials in the URL. Before sending a credential, every IPv4/IPv6 DNS answer for the host is validated and the connection is pinned to the validated address (DNS-rebinding protection). The one exception is a local proxy's fake-ip placeholder range (`198.18.0.0/15`): it cannot point at a private service, so it is accepted and pinned as well, while the same address written literally into the configuration is still refused.
