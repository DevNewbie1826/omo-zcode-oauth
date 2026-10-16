# ZCode 3.12.3 → 3.14.4 protocol diff (2026-09-29)

Checked whether updates to the ZCode desktop app require changes in this repo.
Evidence: CDN `latest.yml` release notes for every 3.12/3.13/3.14 version, the
officially open-sourced repo `zai-org/ZCode` (Apache-2.0, opened 2026-09-21),
and the shipped 3.14.4 mac-arm64 agent bundle (`glm/zcode.cjs`, sha512-verified
against `latest.yml`).

## Version timeline (macOS CDN)

| Version | Release (UTC)      | Note |
|---------|--------------------|------|
| 3.12.3  | 2026-09-16         | our previous default (PR #14) |
| 3.13.x  | —                  | no artifacts on CDN (skipped) |
| 3.14.0  | 2026-09-19         | dynamic workflows; repo-wiki upload fix (the privacy incident); telemetry redaction |
| 3.14.1–3.14.3 | —         | hotfixes |
| 3.14.4  | 2026-09-29         | **disabled CAPTCHA verification for model requests (free tier)** |

Between 3.12.3 and 3.14.0, Z.ai disabled some app features after the repo-upload
controversy (2026-09-21) and open-sourced the codebase.

## Unchanged vs our implementation (verified in the 3.14.4 bundle)

- **ClientRequestSigningV4** — identical: handshake `POST /api/paas/c1f3a7e2/v2/client`,
  `get_sign_key` HMAC proof, `WD_CLIENT_SIGN_KDF_SALT` / `ed25519_priv` /
  `getSignKey_hmac` HKDF labels, `privateCipher` AES-256-GCM envelope, Ed25519
  signature over `{apiKeyId}\n{ts}\n{version}\n{sessionId}\n{nonce}`, PoW 8 bits,
  `X-App-Id: zcode`, `X-Session-Id` required, VERIFY_SIGNATURE_INVALID /
  VERIFY_APIKEY_EXPIRED fail-open semantics.
- **Feature gate** — `GET /api/v1/agent/configs`, 1h cache, `codingPlanSignature.enable`;
  dynamic `proxyEndpoint.mapping` still present.
- **Ultra gateway routing** — `api.z.ai/api/anthropic/v1/messages` →
  `zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`. Now hardcoded in the CLI
  adapter (`official-coding-plan-gateway.ts` in the open-source repo) in addition
  to the gate mapping; our static `ULTRA_BASE_URL` is equivalent.
- **Source headers** — `X-ZCode-Agent: glm`, X-Platform, X-Os-Category,
  X-Os-Version, X-Client-Language, X-Client-Timezone, X-Release-Channel
  ("production"), `X-Title: Z Code@electron`, `HTTP-Referer: https://zcode.z.ai`.
- **User-Agent suffix** — `ai-sdk/provider-utils/4.0.27` still the resolved
  provider-utils for `@ai-sdk/anthropic@3.0.81` (bundle `ZBr="4.0.27"`); our
  UA suffix stays correct.
- **metadata.user_id** — device-identity JSON `{device_id, account_uuid:"",
  session_id}` (anthropic path only) unchanged (PR #10 behavior).
- **OAuth** — `chat.z.ai/api/oauth/authorize`, `zcode.z.ai/api/v1/oauth/token`,
  `cli/init` + `cli/poll/{flowId}` (GET), client id `client_P8X5CMWmlaRO9gyO-KSqtg`,
  poll with locally generated bearer; `data.token` JWT capture unchanged.

## Changed

1. **App version** — default bumped 3.12.3 → 3.14.4 (`ZCODE_APP_VERSION`,
   shared by User-Agent / X-ZCode-App-Version / X-Client-Version). Applied.
2. **Off-peak ticket gateway removed from the app** — the 3.14.4 bundle no
   longer contains `/api/v1/off-peak/ticket`, `X-Coding-Plan-Api-Key`, or
   ticket acquisition; off-peak is now a desktop-host scheduled-task path
   ("off-peak-run" protocol messages, `account-offpeak` provider mode). Our
   opt-in (`ZCODE_OFFPEAK_ENABLE=1`) offpeak.ts path is deprecated: marked in
   its header comment; no code change (opt-in, fail-open, server may still
   expose the endpoints).
3. **Aliyun CAPTCHA layer (new, informational)** — `openai-compatible`
   provider paths can be rejected with code 3007 and retried with
   `x-aliyun-captcha-verify-param`/`-region` headers; 3.14.4 disables it for
   the free tier. Not applicable to our signed anthropic-zai route; no action.

## Conclusion

The only required repo update was the version bump. The signing/OAuth/header
protocol our extension implements is unchanged in 3.14.4.
