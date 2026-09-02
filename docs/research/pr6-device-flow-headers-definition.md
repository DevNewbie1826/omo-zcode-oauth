# PR #6 ideal-state definition: device-flow login + exact ZCode source headers

Date: 2026-09-02 · Base: `main` @ a346ef0 · Branch: `feat/device-flow-and-source-headers`

## Research basis (this session, evidence-backed)

1. **ZCode 3.10.2 host bundle reverse-engineering** (cdn-zcode.z.ai dmg → `out/host/index.js`):
   - `zaiCodingPlan` (paid GLM Coding Plan) = provisioned `zcode-api-key` @ `api.z.ai/api/anthropic` — identical to our extension's path.
   - JWT + `zcode.z.ai/api/v1/zcode-plan/anthropic` gateway = Start-plan path; blocked by Aliyun captcha (err 3007) and entitlement binding (err 3012). gajae-code tried it (PR #1000→#1013→#1017) and reverted within 24h (PR #1016, "no gateway/captcha — live 200").
   - gajae PR #1017 sends an exact-match ZCode client "source" header set on GLM requests as a hedge against server-side client gating (Z.ai docs: coding plan "strictly limited to supported tools").
   - Bundle contains a CLI device-flow OAuth: `POST /api/v1/oauth/cli/init` → `GET /api/v1/oauth/cli/poll/{flow_id}`, no `zcode://` custom-protocol interception.
2. **Live probe (2026-09-02)**: `POST https://zcode.z.ai/api/v1/oauth/cli/init` (Bearer `<64-hex>`, body `{"provider":"zai"}`) → HTTP 200:
   ```json
   {"code":0,"msg":"","data":{"flow_id":"<hex32>","poll_token":"<hex64>",
    "authorize_url":"https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai&state=<hex32>&response_type=code",
    "expires_at":1788320067,"poll_interval_sec":2}}
   ```
   The `redirect_uri` points at a **server-side callback** — the ZCode desktop app cannot consume the code (gajae issue #5184 is structurally mooted).
3. Current defects:
   - `extensions/glm-zcode/index.ts:33` — partial header set, wrong header name (`X-ZCode-Version`; the real header is `X-ZCode-App-Version`), stale version `3.1.2` (current app: 3.10.2).
   - `extensions/glm-zcode/oauth.ts` — login requires manual paste of the `zcode://` redirect URL.

## Decision points (resolved)

- **D1 — keep the provisioned-key path.** Do NOT adopt the gateway/JWT path (captcha + entitlement wall; ZCode itself does not use it for inference; gajae reverted). Evidence: bundle analysis + gajae #1016.
- **D2 — device flow is primary, manual paste is fallback.** If `cli/init` fails (network/shape/4xx), the existing paste flow runs verbatim. Preserves behavior when ZCode kills the endpoint; keeps existing tests meaningful.
- **D3 — headers exact-match gajae #1017 set**, version default `3.10.2`, overridable via `ZCODE_APP_VERSION` / `ZCODE_RELEASE_CHANNEL`; dynamic fields (`X-Platform`, `X-Os-Category`, `X-Os-Version`, `X-Client-Language`, `X-Client-Timezone`) resolved at runtime, printable-ASCII, omitted when empty. No `deviceMid` (gajae #1017 omits it; avoids device fingerprinting).
- **D4 — poll token selection**: prefer `data.poll_token` from the init response, fall back to the client-generated bearer (bundle uses the client token; server returns one — accept either).

## Ideal state

1. `registerProvider` sends the full 11-header source set; `X-ZCode-Version` is gone; env overrides work.
2. `/login glm-zcode`: init → browser login at `authorize_url` → credentials arrive via polling automatically (progress messages); zero paste. Any init failure degrades to today's paste flow.
3. Full existing suite green; new tests cover: device-flow happy path, init-failure fallback, poll expiry, signal abort, header exactness + override.
4. Evidence: live `cli/init` 200 capture; vitest + typecheck green at the final tree.

## Non-goals

- Start-plan/JWT/gateway usage (D1). Plan-quota dashboard measurement (user-side follow-up). README rewrite beyond the login-UX note.

## Verification plan

- RED→GREEN unit tests in `test/source-headers.test.ts` + `test/device-flow.test.ts` (new files, disjoint from `test/glm-zcode.test.ts`).
- Regression: `npx vitest run` (all), `npx tsc --noEmit`.
- Real-surface: live `cli/init` curl capture (already captured; re-verify at final tree).
