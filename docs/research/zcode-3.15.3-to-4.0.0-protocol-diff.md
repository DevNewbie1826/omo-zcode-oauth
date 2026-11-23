# ZCode 3.15.3 -> 4.0.0 protocol diff (2026-11-23)

Checked whether the ZCode 4.0.0 desktop release requires changes in this repo.

Evidence: the CDN `latest.yml` for 4.0.0 (release date, artifact sha512, release
notes), the open-source repo `zai-org/ZCode` at tag `v4.0.0` commit `a4b44451`,
and the sha512-verified 4.0.0 macOS arm64 bundle: agent bundle
`Resources/glm/zcode.cjs` (15,849,173 bytes) plus the extracted Electron host
`out/host/index.js` (2,456,138 bytes). Offline analysis only; no request was sent
to `zcode.z.ai` or `api.z.ai`.

Citation conventions used below:

- `apps/...` and `packages/...` are paths at tag v4.0.0 (commit `a4b44451`).
- `bundle @<byte>` is a byte offset in the 4.0.0 macOS arm64 bundle's
  `Resources/glm/zcode.cjs` (single-line minified code, so offsets, not lines).
- `host @<byte>` is a byte offset in the same bundle's extracted
  `out/host/index.js`.
- Plugin paths are repo-relative to this repository.

## Version timeline (macOS CDN `latest.yml` + GitHub Releases)

| Version | CDN releaseDate (UTC) | GitHub Release | Note |
|---------|-----------------------|----------------|------|
| 3.15.3  | 2026-10-16            | —              | previous default (PR #15) |
| 3.16.1 / 3.16.2 / 3.16.3 | 2026-10-17 ~ | —        | |
| 3.17.1  | 2026-10-30            | 2026-10-30     | |
| 3.17.2  | 2026-11-04            | 2026-11-04     | |
| 3.18.0 / 3.18.1 / 3.18.2 | 2026-11-12 ~ | 3.18.2: 2026-11-16 | `minimumSystemVersion: 22.0.0` introduced |
| 3.19.0 / 3.19.1 | 2026-11-19 / 2026-11-20 | —      | |
| **4.0.0** | **2026-11-22T11:43:52Z** | **2026-11-23T08:14Z** (build `6d86cdaa…`) | major; regional plugin store, on-demand workflow enable when the config service is down, no extra visual acceptance step for document/sheet/presentation plugins, plus bug fixes. **No protocol change mentioned in the release notes** |

- Artifact: `ZCode-4.0.0-mac-arm64.zip`, 305,610,968 bytes, sha512
  `KCz2AO…EqA==` as listed in `latest.yml`; the DMG is 317,392,912 bytes.
- `minimumSystemVersion: 22.0.0` in `latest.yml` is the Darwin kernel version
  (macOS 13) consumed only by the Electron updater; it is never sent to the
  model API.
- Server-enforced minimum version observed on 2026-11-23:
  `client/configs.forceUpdate.minimalVersion = 3.5.3`, so a client stamping
  3.15.3 is still accepted (see the Z11 section).

## Unchanged vs our implementation

### Z1 — ClientRequestSigningV4 (handshake, KDF, signature text, PoW, headers, fail-open)

**Verdict: Unchanged.**

The wire contract is byte-for-byte the same in 4.0.0:

- Handshake `POST /api/paas/c1f3a7e2/v2/client` with
  `Authorization: {id}.{secret}`, body `{apiKey, nonce, sig, ts}` — same as
  `extensions/glm-zcode/signing.ts:264-271`; bundle @3920531 carries the path.
- KDF labels `WD_CLIENT_SIGN_KDF_SALT`, `getSignKey_hmac`, `ed25519_priv`, action
  `get_sign_key` — same as `signing.ts:44-47`; bundle @3919630 (`Ppa`/`Opa`/`Dpa`
  /`Lpa`), HKDF helper `u0o` identical (SHA-256, 256-bit, same salt).
- Handshake HMAC text `get_sign_key\n{id}\n{ts}\n{nonce}` — same as
  `signing.ts:127`; bundle @3926800.
- `privateCipher` envelope: IV 12 / tag 16, AAD = apiKeyId, plaintext
  base64(pkcs8), Ed25519 — same as `signing.ts:132-153`; bundle `a0o`.
- Per-request signed text `{id}\n{ts}\n{version}\n{sessionId}\n{nonce}` — same as
  `signing.ts:201`; bundle @3925000.
- Header set `X-Client-Ts`, `X-Client-Version`, `X-Client-Sig`, `X-Session-Id`,
  `X-Client-Nonce`, `X-App-Id: zcode`, `X-Client-Pow` — same as
  `signing.ts:333-343`; bundle @3925389. Inbound copies are stripped before
  re-signing (`S4s` list).
- PoW: 8 bits, challenge = first 32 hex of
  SHA-256(`{id}\n{appId}\n{sessionId}\n{ts}`), candidate
  `{nonce}{counter:08x}` — same as `signing.ts:158-188`; bundle `l0o`/`Mpa`.
- Failure codes: HTTP != 200, business `code === 500`, business `code !== 200`,
  missing `privateCipher`, plus `failOpenEligible` classification covering
  cryptography/timeout/network/protocol/server/business handshake errors; only
  `invalid-config` and `disposed` fail closed. The plugin's catch-all fail-open
  (`signing.ts:302-354`) is a superset, never narrower.

Sub-findings, none of which changes the verdict:

1. Evidence location: the brief points at
   `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`, but
   that file is the V4 conversation gateway and contains zero signing symbols
   (0 hits for `Ed25519`, `handshake`, `privateCipher`, `X-Client-Sig`). The
   signer exists only in the bundle (@3,917,206–3,928,800); the source tree has
   no signing implementation.
2. PoW nonce length differs: 4.0.0 uses a 12-byte internal nonce (`E_t(12)`,
   32-hex `X-Client-Pow`), the plugin uses 16 bytes (40-hex). The nonce is
   client-chosen and only hashed after the 32-hex challenge, so verification
   semantics are unchanged.
3. Additive client behaviour: a 401 whose body matches
   `VERIFY_SIGNATURE_INVALID` / `VERIFY_APIKEY_EXPIRED` triggers a re-handshake,
   one retry, then an unsigned bypass. Wire-neutral; the plugin has no retry.

Plugin action: **none**. `signing.ts` already matches; the version used in the
signed text comes from `zcodeAppVersion()`, so the version bump below is the only
change that reaches this path.

### Z3 — ultra gateway routing `api.z.ai/api/anthropic/v1/messages` -> `zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`

**Verdict: Unchanged.**

- 4.0.0 source keeps the exact pair in
  `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts:8-10`,
  joined to `endpointOrigin`, whose production default is
  `https://zcode.z.ai` (`packages/shared/src/zcodeEndpoint.ts:3`). The rewrite is
  pinned by `apps/zcode-cli/packages/adapters/tests/official-coding-plan-gateway.test.ts:14-19`.
- The shipping bundle does not compile that static map (`GATEWAY_PATH_BY_ENDPOINT`
  and `api/anthropic/v1/messages` both 0 hits); it obtains the same from/to pairs
  from `data.proxyEndpoint.mapping` (bundle @4308792 schema, @4306049 consumer,
  @4312739 config URL). The `/api/v1/ultra` + `/api/v1/ultra-zai` prefixes survive
  as the `X-ZCode-Authorization` target allowlist (bundle @4308386).
- The plugin already sends the 4.0.0 target directly:
  `extensions/glm-zcode/models.ts:15` (`ULTRA_BASE_URL`), and the pi-ai/SDK appends
  `/v1/messages`.

Plugin action: **none**. Note the residual design risk, unchanged from before:
because the plugin hardcodes the ultra base, a future gate-delivered remapping
would be followed by the stock app but not by this plugin. Nothing in the 4.0.0
artifacts indicates such a change.

### Z5 — User-Agent suffix `ai-sdk/provider-utils/<ver> runtime/node.js/<node>`

**Verdict: Unchanged.**

- `@ai-sdk/anthropic` is pinned exactly at `3.0.81`
  (`apps/zcode-cli/packages/adapters/package.json:112`), which resolves
  `@ai-sdk/provider-utils` `4.0.27` in both lockfiles
  (`apps/zcode-cli/pnpm-lock.yaml:3555-3559`, `pnpm-lock.yaml:13618-13622`).
- The bundle's anthropic transport appends `rmo="4.0.27"` (constant @3621451,
  append site @3621675 via `n2`/`withUserAgentSuffix` and `y_t` @3601205). The
  other constant `Vua="4.0.39"` (@3867535) belongs to the `openai-compatible`
  copy and is never used by the anthropic class.
- The plugin's static UA at `extensions/glm-zcode/models.ts:254` already carries
  `ai-sdk/provider-utils/4.0.27 runtime/node.js/${process.versions.node}`, and
  `test/source-headers.test.ts:51,62` pins the provider-utils version.

Shape differences that predate 4.0.0 and are not protocol changes: 4.0.0 also
emits an `ai-sdk/anthropic/3.0.81` token from the SDK factory, and its Electron
Node 24 runtime reports `runtime/node.js/24` (the global `navigator.userAgent`
branch wins over `process.version`). Plugin action: **none**.

### Z6 — `metadata.user_id = JSON({device_id, account_uuid:"", session_id})` on the anthropic path

**Verdict: Unchanged.**

- 4.0.0 keeps the builder verbatim:
  `apps/zcode-cli/packages/adapters/src/model/anthropic-request-metadata.ts:7-15`
  emits `{device_id, account_uuid: "", session_id}` in that field order, gated to
  `providerKind === "anthropic"` (`:18-31`).
- The device id still comes from `.zcode/v2/telemetry-state.json`
  (`apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts:58-60`), the
  same file the plugin reads in `extensions/glm-zcode/index.ts:278-287`.
- Bundle: `account_uuid` appears exactly once in the whole bundle, in the builder
  `Yya` @4175663; the anthropic-only injection is `QSo` @4209541, and both
  generate/stream option builders pass it through.
- 4.0.0 additionally strips `sess_` / `subagent_agent_` prefixes from the host
  session id (`apps/zcode-cli/packages/adapters/src/model/runner-attribution.ts:105-115`);
  the plugin generates its own bare UUID via `zcodeSessionId()`
  (`signing.ts:91-98`), so the normalisation is a no-op for it.

Plugin action: **none**. `deviceIdentityMetadata()` (`index.ts:328-332`) and the
`before_provider_request` merge (`index.ts:368-378`) already emit the 4.0.0 shape.

### Z10 — CAPTCHA layer (error 3007, Aliyun `x-aliyun-captcha-verify-param`)

**Verdict: Unchanged: still openai-compatible-only, never on the signed anthropic path.**

- The surviving client gate requires `providerKind === "openai-compatible"` and
  `start-plan` (bundle `hEn` @4250397; source stub
  `apps/zcode-cli/packages/adapters/src/model/runner-options.ts:22-25`). The retry
  class (`CaptchaRequestRetry.claim`, bundle @4249642) also requires
  `accountAccess.mode === "start-plan"` plus the desktop host header-refresh port
  and is bounded to one attempt.
- 4.0.0 moved the built-in Start Plan providers to `anthropic-messages`
  (`config/provider/zcode-builtin.json:1100-1108`, kind mapping
  `packages/services/src/model-provider/legacyModelProviderSerialized.ts:491-500`),
  so the app's own Start Plan traffic cannot satisfy the gate; it is vestigial.
- No model-path caller injects `X-Aliyun-Captcha-Verify-*`: the header builder
  exists (bundle @820951) and `requestVerificationClaimHeaders(`,
  `allowRequestVerificationHeaders(`, `requiresRequestVerification(` have 0 call
  sites in the bundle. The open-source tree ships the layer as no-op stubs
  (`apps/zcode-cli/packages/adapters/src/model/request-security-edition/recovery.ts:4-26`,
  `packages/shared/src/request-security-edition/verification-policy.ts:4-22`).
- 3007 is classified terminal (`failure-provider-business-codes.ts:99-107`,
  `retryable: false`) and documented as an error banner for official builds
  (`docs/start-plan-provider-business-errors.md:19`).

Plugin action: **none**, and do not add `x-aliyun-captcha-*` headers: the app
itself cannot satisfy the gate on its anthropic route.

### Z11 — minimum version / downgrade block

**Verdict: Unchanged: no client-side floor added; the gate is desktop-startup-only and server-driven.**

- The gate is `GET /api/v1/client/configs?app_version=<ZCODE_VERSION>&platform=…`
  -> `data.configs.forceUpdate.minimalVersion`, compared against `ZCODE_VERSION`;
  startup is blocked only when current < minimal
  (`packages/desktop/src/main/forceUpdateGuard.ts:15,50-58,167-176`;
  `packages/shared/src/remoteAppConfig.ts:84-98`;
  `packages/shared/src/forceUpdate.ts:119-137`). Fetch/parse failure fails open
  (`forceUpdateGuard.ts:178-195`).
- Blocking happens before the main window exists and only in packaged production
  builds (`packages/desktop/src/main/index.ts:2833-2853`).
- No hard-coded application minimum exists in 4.0.0: `3.5.3` and `3.15.3` have 0
  hits in the source tree and in the bundle. The only hard-coded minima are
  Electron-updater OS floors (`minimumSystemVersion: "13.0.0"`,
  `packages/desktop/electron-builder.config.js:975`;
  `minimumSystemVersion: 22.0.0` in `latest.yml`, i.e. Darwin 22), never sent as
  headers.
- Bundle equivalents: config reader @1044501, URL builder @1044951, requirement
  resolver @1091956; asar main @727223 / @728827 / @729886.
- The recorded server floor (3.5.3) stays below the plugin's stamped 3.15.3, so
  no request-path change follows. Risk: the floor is server-controlled and there
  is no client retry path; the mitigation is keeping the version constant
  current, which the bump below does.

Plugin action: **none** for the gate itself; the version bump (below) is what
keeps the stamp above the floor.

## Changed

### Z2 — gate `GET /api/v1/agent/configs` (`codingPlanSignature.enable`, `proxyEndpoint.mapping`)

**Verdict: Changed: the endpoint survives as a routing read, the signing flag is gone, and the config request credential was renamed.**

| Sub-item | Verdict | Evidence |
|----------|---------|----------|
| Endpoint still requested | unchanged | bundle @4312744 (`/api/v1/agent/configs`); `apps/zcode-cli/docs/design/v2/model/provider-endpoint-routing.md:49-57` |
| `data.proxyEndpoint.mapping` semantics | unchanged (routing only) | bundle parser @4306083 and strict zod schema @4308837; design doc `:56,61-80,213-221` |
| `data.codingPlanSignature.enable` | **removed** | 0 hits for `codingPlanSignature` in source and bundle (also for `signatureEnable`/`enableSignature`/`clientSignature`); `docs/model-provider-project-access-token.md:245,256,258` |
| Config request credential | **changed** `x-api-key` -> `x-api-key-id` | bundle @4305678; `docs/model-provider-project-access-token.md:245` |
| Brief's Sources column | incorrect | the three named adapter header files contain none of these symbols |

The plugin's gate (`extensions/glm-zcode/signing.ts:41,214-241`) therefore reads a
field the 4.0.0 app no longer reads at all. It stays safe: a response containing
only `proxyEndpoint` yields `absent` -> `sign: true` (`signing.ts:234-235`), and
any non-2xx/non-zero-code answer yields `no-answer` -> still sign.

Plugin action: **none required for compatibility.** Optional cleanups only:
correct the header comment at `signing.ts:11-17` to say the flag was removed in
4.0.0; and, only if the gate read is kept long-term, switch its probe credential
from `x-api-key` to `x-api-key-id` (the apiKeyId half of the provisioned key) to
mirror 4.0.0. Existing tests (`test/signing.test.ts:293-299,319,355`) already pin
the 4.0.0-shaped responses.

### Z4 — source header set (`X-ZCode-Agent: glm` + attribution headers)

**Verdict: Changed: one header value, `X-Os-Version`.**

All twelve names, their casing, and their presence on the anthropic model path
are identical; the only difference is what `X-Os-Version` contains:

- 4.0.0 sends `os.release()` (short kernel release):
  `apps/zcode-cli/packages/bootstrap/src/runtime-platform-headers.ts:5-13`
  imports `release as readOsRelease` from `node:os`; bundle platform builder
  @14914579 uses `U4t.release()`.
- The plugin sends `os.version()` (full kernel build string with spaces and a
  timestamp): `extensions/glm-zcode/models.ts:261`.

Layout of the set in 4.0.0: shared builder
`packages/shared/src/zcode-source-headers.ts:3-7,45-58`; CLI builder
`apps/zcode-cli/packages/bootstrap/src/model-config.ts:51-69` (installed as
`defaultHeaders` at `:33`, merged in
`apps/zcode-cli/packages/adapters/src/model/model-execution.ts:232-236`); platform
builder as above. `X-Client-Version` remains signing-only in both
(`signing.ts:335`; bundle @3925412).

Everything else is unchanged on the wire: `X-ZCode-Agent: glm`,
`X-Release-Channel` (production default), `X-Platform`
(`${platform}-${arch}`), `X-Os-Category` mapping, `X-Client-Language`,
`X-Client-Timezone`, `X-Title: Z Code@electron` (plugin impersonates the desktop
source), `HTTP-Referer: https://zcode.z.ai`, and the UA string. 4.0.0's
`X-Device-Mid` on routing/config GETs is additive and out of this set.

Plugin action: **one-line value fix** — `models.ts:261` `os.version()` ->
`os.release()`, plus a test pin in `test/source-headers.test.ts`.

### Z7 — OAuth device flow and Coding-Plan key provisioning

**Verdict: Changed: the device flow and broker are unchanged; key provisioning changed.**

Unchanged sub-items (evidence):

- `cli/init`: `POST .../oauth/cli/init`, body `{"provider":"zai"}`, client-generated
  32-byte hex bearer, same required fields `flow_id` / https `authorize_url` /
  `expires_at` / `poll_interval_sec >= 1`
  (`apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts:98-99,194-198`; bundle
  @4570477). 4.0.0 adds an optional `server_time` used only for clock-skew
  tolerance (`apps/zcode-cli/packages/bootstrap/src/auth-login.ts:97-100`); the
  plugin ignores it.
- `cli/poll/{flowId}`: GET with bearer only, same transient set 408/429/5xx/network,
  same ready contract `data.token` + `user.user_id` + provider `access_token`
  (`cli-oauth.ts:118-119,242-248`; bundle @4572543). Business code 3004 with
  HTTP 400 is terminal (`cli-oauth.ts:9`).
- Client id `client_P8X5CMWmlaRO9gyO-KSqtg`
  (`packages/services/src/oauth/providers/zaiProviderConfig.ts:22-28`,
  `packages/shared/src/zcodeEndpoint.ts:12`; bundle @671032; a test-only id
  `client_RzngVdSk8sYsG2_3HzOMdQ` also exists).
- Broker `https://zcode.z.ai/api/v1/oauth/token` with body
  `{provider, code, redirect_uri, state}` and response `data.zai.access_token` +
  `data.token` (`zaiProviderAdapter.ts:303-345`; host @1281079-1282010).
- Callback literal `zcode://oauth/callback` retained
  (`packages/services/src/oauth/providers/configUtils.ts:7`); the desktop now
  fronts it with an `…/app/oauth/login?redirect=zcode://oauth/callback` hop.

Changed sub-item: Coding-Plan API key provisioning.

- 4.0.0 creates the key with `usageScene: API_KEY_USAGE_SCENE.CODING_PLAN` (= 1)
  (`packages/shared/src/project-access-token-client.ts:355-389`,
  `packages/shared/src/api-key-usage-scene.ts`; bundle @1124421/@1127353). The
  plugin sends `{name}` only (`extensions/glm-zcode/oauth.ts:183`), so new keys
  land in the default scene.
- 4.0.0's runtime credential is a short-lived Project Access Token from
  `POST /api_keys/{apiKeyId}/access_tokens {clientType:"zcode", clientVersion}`
  with server `expiresIn`/`expiresAt`
  (`project-access-token-client.ts:213,220-228`; bundle @1124571). The plugin's
  signature design needs the long-lived `id.secret`, so it keeps the copy path.
- `/api_keys/copy/{id}` and `secretKey` are absent from both 4.0.0 clients
  (0 hits in the agent bundle and host bundle; production source has only an
  unused type field). Whether the server still serves `/copy/{id}` cannot be
  determined offline.
- Still compatible: the three-part JWT/PAT credential and the legacy two-part
  `id.secret` credential are both parsed by the 4.0.0 bundle (`cBr` @1127593;
  `id.secret` uses handshake field `apiKey`), so the plugin's derived key keeps a
  working verification path. Unchanged elsewhere: `z/login {token}`,
  `getCustomerInfo`, `api_keys` list/create URL, key name `zcode-api-key`.

Plugin action: **send the Coding-Plan scene** on create (`usageScene: 1`, ignored
by pre-4.0 servers) and move the two pinned create-body tests with it. Keep the
copy path and the 10-year local TTL.

### Z8 — official GLM model id spelling and list

**Verdict: Changed: the list is identical (22 ids, same order), but 4.0.0 narrowed where the normalizer may be used.**

- Content unchanged: 4.0.0 `canonicalIds`
  (`packages/shared/src/official-glm-model-id.ts:2-33`), bundle `BIr` @533687, and
  the plugin's `OFFICIAL_GLM_MODEL_IDS` (`extensions/glm-zcode/index.ts:334-364`)
  are the same 22 strings in the same order (checked programmatically, both
  directions true). `glm-5.3-flashx`, `glm-5.3-flashx-legal`, and `glm-5.4`
  remain outside the list in both.
- Use changed: 4.0.0's module header restricts the normalizer to the official
  model list, the telemetry whitelist, and one-way migrations, explicitly
  forbidding "generic request rewriting". All non-test call sites are migrations
  (`packages/shared/src/legacy-model-provider-identity.ts:8-13`, gated to official
  providers), Start-plan balance ids
  (`packages/services/src/model-provider/zaiStartPlanBilling.ts:144`), and
  telemetry (`packages/shared/src/telemetryRedaction.ts:15,154`). The request path
  sends the bound `modelId` verbatim.
- Live display names cannot replace the constant: `glm-5.3-flashx` is a
  deliberate lowercase official id (`config/provider/zcode-builtin.json:44-48`;
  `docs/builtin-provider-maintenance/expansion-plan.md:56` says not to re-case it
  from the display name), `glm-5.3-flashx-legal` has no app precedent, and 12 of
  the 22 listed ids are absent from the live `/v1/models` list, so a
  display-name-derived map would drop them. 10 of 13 live ids are covered by the
  frozen list; the other three pass through unchanged, which is exactly what
  4.0.0's normalizer also does for unknown ids.

Plugin action: **no code change required for parity**. The plugin's rewrite of the
22 known ids matches the app's spelling exactly, and unknown ids (including
`glm-5.4`) pass through lowercase in both. If display-name casing is desired later
it is a product decision: add `officialId` plus an exception table in
`extensions/glm-zcode/live-catalog.ts` and keep the constant as the offline
fallback.

### Z9 — off-peak: account-off-peak provider mode vs. "ticket path removed"

**Verdict: Changed: the ticket client moved to the desktop host and the client-side time window is gone; the provider mode and ticket protocol are unchanged.**

- Provider mode unchanged: 4.0.0 ships
  `account:zai-offpeak-idle-plan` / `account:bigmodel-offpeak-idle-plan` with
  `"mode": "off-peak"`, `anthropic-messages`, base URL
  `https://zcode.z.ai/api/v1/off-peak/anthropic`
  (`config/provider/zcode-builtin.json:1180-1194`;
  `packages/shared/src/off-peak-types.ts:40-48`; bundle @1056065, mode enum
  @564143). The agent bundle still has 0 hits for `off-peak/ticket`, and
  `X-ZCode-Route` has 0 hits in source and bundle.
- The ticket path is not removed; it is a host-side service client:
  `GET /api/v1/off-peak/ticket/availability`, `POST /ticket`,
  `POST /ticket/status`, `POST /ticket/{id}/settle`
  (`packages/services/src/session/offPeakServerClient.ts:168,216-274`; host
  @1910254 `createOffPeakServerClient`). Per-attempt auth is
  `Authorization: Bearer <jwt>` + `X-Coding-Plan-Api-Key` + `X-Off-Peak-Ticket-ID`
  (`packages/services/src/session/offPeakRuntimeModel.ts:254-268`) — identical to
  `offpeak.ts:200-206`. Error codes 3101/3103/3102/3106 survive.
- Client-side window removed: the host neither stores nor evaluates an off-peak
  window; the server promotes `queued -> ready`
  (`docs/off-peak-task/decisions.md:246`), and `isOffPeakWindow` /
  `ZCODE_OFFPEAK_ENABLE` have 0 occurrences in 4.0.0. The plugin's KST
  00:00-10:00 gate (`offpeak.ts:34-38`) is therefore a plugin-local pre-filter,
  not a mirror of 4.0.0 behaviour.
- Agent-side ticket lifecycle still exists in the CLI
  (`apps/zcode-cli/packages/core/src/runtime/off-peak/*`: `prepareOffPeakTurn`,
  `OffPeakTicketAuthority` with `off_peak_ticket_mismatch`, `waitForTicket`), and
  the user entry is the `OffPeakCreate` tool, not a provider switch.

Plugin action: **none**. Endpoints, headers, ticket states and error codes all
match; `offpeak.ts` stays opt-in and unchanged.

## Conclusion

The protocol the plugin implements is unchanged in ZCode 4.0.0 for signing,
gateway routing, source headers (except one value), User-Agent tokens, anthropic
`metadata.user_id`, the OAuth device flow and broker, the CAPTCHA layer (still
off the anthropic path), and the minimum-version gate. The substantive changes
are: the signing gate field `codingPlanSignature` is gone (Z2), `X-Os-Version`
now carries `os.release()` (Z4), and Coding-Plan keys are created with
`usageScene: 1` while the app moved to short-lived Project Access Tokens (Z7).
The model-id list is identical but is no longer used for request rewriting (Z8),
and the off-peak ticket client now lives in the desktop host with a server-owned
window (Z9).

### Required plugin changes

1. **Version default 3.15.3 -> 4.0.0** — `extensions/glm-zcode/models.ts:23`
   (`zcodeAppVersion()` default). Update the pinned literals:
   `test/source-headers.test.ts:46,51,52`, `test/signing.test.ts:232,234,248,259`
   (the signed-text assertions embed the version), and `README.md:122`
   (and the `3.15.3` prose at `README.md:103,111` if the text is being refreshed).
2. **`X-Os-Version` value** — `extensions/glm-zcode/models.ts:261`:
   `os.version()` -> `os.release()`; add
   `expect(headers["X-Os-Version"]).toBe(os.release())` to
   `test/source-headers.test.ts` (import `release` from `node:os`).
3. **Coding-Plan key creation scene** — `extensions/glm-zcode/oauth.ts:183`:
   send `{ name: API_KEY_NAME, usageScene: 1 }`. Update
   `test/glm-zcode.test.ts:317` to `{ name: "zcode-api-key", usageScene: 1 }` and
   assert the same create body in the provisioning fixtures at
   `test/device-flow.test.ts:42-58,243-246`. The `/copy/{id}` step stays.

No other code change is required. Explicitly not required, and why:

- Z1: keep the 16-byte PoW nonce and skip the 401 verify-retry; both are
  implementation-level only. Do not bump the version inside `signing.ts` — it
  already reads `zcodeAppVersion()`.
- Z2: keep the fail-open signing gate; only the doc comment at
  `signing.ts:11-17` is stale. Switching the probe to `x-api-key-id` is optional
  alignment, not needed while the probe is tolerated.
- Z5: no change to the frozen `ai-sdk/provider-utils/4.0.27` token; do not add an
  `ai-sdk/anthropic/3.0.81` token for impersonation.
- Z8: no change; the list and spelling already match, and unknown ids pass
  through.
- Z9: no change to `offpeak.ts`; optionally note in its header that 4.0.0 owns
  the window server-side.
- Z10: do not add `x-aliyun-captcha-*` headers; the layer is unreachable on our
  route in 4.0.0.
- Z11: no gate code exists in the plugin, and none is needed; the version bump
  is the mitigation for a raised server floor.
