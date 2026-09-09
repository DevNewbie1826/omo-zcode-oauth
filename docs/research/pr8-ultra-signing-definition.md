# PR #8 이상 상태 정의: ultra 게이트웨이 + 클라이언트 서명 (ClientRequestSigningV4)

작성일: 2026-09-09 · 근거: ZCode 3.11.2 앱 번들 역설계 + 실계정 라이브 프로브 (2026-09-09)

## 1. 배경 (Current State)

Z.AI가 GLM Coding Plan 대상 **Usage Campaign**(2026-09-03 ~ 09-20, 매일 23:00–09:00 SGT = 00:00–10:00 KST)을 운영 중이다. glm-5.3-Flash 한정:

| 사용 경로 | 쿼터 소모 |
|---|---|
| ZCode 앱 경유 | **0 (무제한)** |
| 기타 지원 Agent 경유 | 플랜 기준 **2배** 제공 |

PR #6까지의 확장은 `api.z.ai/api/anthropic` 직접 Bearer 호출이라 "기타 Agent" 분류다. "ZCode 경유" 판정은 헤더 세트가 아니라 **클라이언트 서명 + ultra 게이트웨이 경로**로 이루어진다.

## 2. ZCode 3.11.2의 실제 요청 메커니즘 (번들+라이브 검증)

번들: `app.asar → Resources/glm/zcode.cjs` (zcode-agent 0.13.3 계열), 핵심 심볼 `csn/HRt`(소스 헤더), `yce`(CodingPlanSignatureFeatureGate), `Sce/mFe`(ClientRequestSigningV4Manager/Signer), `kRt`(PoW), `xnt`(attribution 헤더).

1. **소스 헤더** (PR #6과 동일 세트, 버전 3.11.2). 요청별 동적 변형에는 `X-Device-Mid`도 있으나 에이전트 경로는 미포함 — 종전대로 미송신.
2. **agent/configs**: `GET https://zcode.z.ai/api/v1/agent/configs` (소스 헤더 + `x-api-key`) →
   - `data.codingPlanSignature.enable` — 서명 기능 게이트 (라이브: `true`)
   - `data.proxyEndpoint.mapping` — 요청 URL 리라우팅 테이블. 라이브:
     - `https://api.z.ai/api/anthropic/v1/messages` → **`https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`**
     - `https://open.bigmodel.cn/api/anthropic/v1/messages` → `https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`
3. **핸드셰이크** (`api.z.ai` origin 고정): `POST /api/paas/c1f3a7e2/v2/client`
   - 헤더: `Authorization: <id.secret 원문>` (Bearer 아님)
   - body: `{apiKey: "id.secret", nonce: <16B hex>, ts, sig}`. `sig` = base64(HMAC-SHA256(HKDF-SHA256(secret, salt="WD_CLIENT_SIGN_KDF_SALT", info="getSignKey_hmac"), `get_sign_key\n{id}\n{ts}\n{nonce}`))
   - 응답 `data.privateCipher` = base64(IV(12) + AES-256-GCM(base64(pkcs8 Ed25519 priv), aad=id, key=HKDF(secret, info="ed25519_priv"))) — **평문이 한 번 더 base64**
4. **요청별 서명**: `X-Client-Ts`(ms), `X-Client-Nonce`(16B hex), `X-Client-Sig` = base64(Ed25519(`{id}\n{ts}\n{version}\n{sessionId}\n{nonce}`)), `X-Client-Pow` = 8선행제로비트 SHA-256 PoW(챌린지 = sha256hex(`${id}\nzcode\n{sessionId}\n{ts}`) 앞 32hex), `X-App-Id: zcode`, `X-Client-Version`, `X-Session-Id` 필수. attribution으로 `x-request-id`, `x-zcode-trace-id`, `x-query-id`, `x-zcode-session-type` 동반.
5. **Fail-open**: 게이트 꺼짐/핸드셰이크 실패/재시도 후에도 401(VERIFY_*)이면 미서명으로 전송. ultra 게이트웨이는 미서명도 수용함(라이브 확인).

라이브 프로브 (2026-09-09, 실제 프로비저닝 키): 게이트 200(enable:true) → 핸드셰이크 200(키 복호화 성공) → **서명+ultra-zai 200 실완성응답**, 미서명 ultra 200, 서명+api.z.ai 200. 쿼터 효과(0 소모)는 캠페인 시간대(00:00–10:00 KST)에만 발동하므로 프로브 시점(낮)에는 관측 불가 — 메커니즘 재현만 검증.

## 3. 이상 상태 (Ideal End State)

**"glm-zcode 확장이 ZCode 3.11.2와 동일한 서명된 요청을 ultra 게이트웨이로 보낸다. 서명 불가 시 종전의 미서명 동작으로 자동 폴백한다."**

## 4. 의사결정 (Evidence-based)

| # | 결정 | 근거 |
|---|---|---|
| P1 | baseUrl 기본값을 `https://zcode.z.ai/api/v1/ultra-zai/anthropic`로. `ZCODE_ANTHROPIC_BASE_URL`로 직접 엔드포인트 복귀 가능 | pi-ai 확장 표면에 per-request URL 리라우팅 훅이 없어 앱의 동적 mapping을 재현 불가 — 정적 목적지가 유일한 등가물. 라이브 200 확인 |
| P2 | 서명 주입은 `pi.on("before_provider_headers")` 훅. 감지는 `X-ZCode-Agent: "glm"` + `Authorization: Bearer` 파싱 | senpi가 요청마다 `transformHeaders`를 await로 호출(runner.emitBeforeProviderHeaders). Authorization·정적 헤더가 모두 이 시점에 존재(applyAuth 검증) |
| P3 | 게이트 1h 캐시, 핸드셰이크 키 per-apiKey 캐시, 모든 실패는 미서명 폴백(예외 밖으로 안 나감) | 앱의 fail-open·캐시 TTL(tTn=1h) 재현. 훅에서 throw하면 에러 이벤트만 남고 요청은 계속되므로, 실패 무시가 정확한 등가 |
| P4 | PoW 8bit, nonce 16B, 버전은 `ZCODE_APP_VERSION`(기본 3.11.2) 공유 | 번들 상수(ERt=16, dTn=8) 및 `clientVersion = X-ZCode-App-Version ?? agent version` |
| P5 | X-Device-Mid 미송신 유지 | 에이전트 경로 미사용 + 디바이스 핑거프린트 회피(PR #6 D3 승계) |
| P6 | 카탈로그(live /v1/models)는 api.z.ai 직접 유지 | 미서명 GET으로 200 확인됨; ultra 필요 없음 |

## 5. 비-목표 (Non-goals)

- 401 VERIFY_* 감지 재핸드셰이크(after_provider_response에는 body reason이 없어 불가) — 프로세스 재시작 시 자연 갱신
- 동적 proxyEndpoint mapping 폴로잉(P1 한계 명시)
- X-Device-Mid 송신, bigmodel(중국) 게이트웨이 지원

## 6. 검증 계획/결과

| 기준 | 시나리오 | 결과 |
|---|---|---|
| C001 | vitest: 핸드셰이크 요청형(Authorization 원문 키, body 필드), privateCipher 복호화(로컬 생성 키로 서버측 암호화 재현), PoW/Ed25519 서명 검증 | 통과 |
| C002 | vitest: 게이트 꺼짐/핸드셰이크 거절/타 provider/키 불량 → 미서명 폴백, fetch 0회 | 통과 |
| C003 | vitest: 훅 wiring(`before_provider_headers` 등록·위임), baseUrl env 오버라이드 | 통과 |
| C004 | 전체 스위트 83 통과 + `npx tsc --noEmit` 클린 | 통과 |
| C005 | 라이브 와이어(`LIVE_ZCODE_WIRE=1`): 실제 키로 streamSimple + 훅 → ultra 200 완성 텍스트 | 통과 (1.6s) |
