# 브리프: glm-zcode 라이브 카탈로그 자동 반영 + 정식 프로바이더화 + ZCode 4.0.0 정렬

작성일: 2026-11-23 · 상태: 조사 완료, 구현 전 (코드 변경 0건) · 대상: `omo-zcode-oauth` main `31729f1` (PR #15 병합) + 미커밋 glm-5.4 핫픽스

---

## 0. 요약 (TL;DR)

| # | 결론 | 한 줄 근거 |
|---|---|---|
| 1 | **GLM-5.4가 바로 안 보인 근본 원인은 플러그인이 아니라 호스트(senpi 2026.11.19-5)다.** 세션 안에서 모델 카탈로그를 네트워크로 자동 갱신하는 경로가 꺼져 있다 | `ModelRuntime.modelNetworkEnabled` 항상 `false`. 시작 시 "background refresh", `/model`의 "Refreshing model catalogs…", 확장 등록 직후 refresh 모두 확장의 `refreshModels`에 `allowNetwork:false`로 도달 (실제 런타임 모듈로 프로브 확인) |
| 2 | **네트워크로 도달하는 트리거는 `/login <provider>` 직후 하나뿐이다.** `omo update --models`는 확장을 로드하지 않는 별도 프로세스라 glm-zcode가 대상에서 빠진다 | `package-manager-cli.js refreshModelCatalogs()`가 `ModelRuntime.create`만 호출 (확장 로더 없음). README의 "update --models로 강제 갱신"은 glm-zcode에 거짓 |
| 3 | **플러그인은 하드코딩 2곳 + 24h TTL + 수동 배포 구조라 새 모델마다 코드 편집·런타임 복사·재시작이 필요하다** | 오늘 `MODELS`와 `OFFICIAL_GLM_MODEL_IDS`에 `glm-5.4`를 손으로 넣음 (두 트리에 미커밋). live 엔드포인트는 `display_name`("GLM-5.4")을 이미 주어 casing 맵은 파생 가능 |
| 4 | **"알 수 없는 경고"의 정체는 `Warning: No models match pattern "glm-zcode/glm-5.4"`다.** 원인도 #1 (레지스트리에 모델 없음) | 오늘 12:45:52 ×3, 12:54:56, 12:55:11 UTC, omo 디버그 로그 5건. senpi `resolveModelScope`가 stderr로 찍고 TUI는 이를 "hidden stderr"로 숨김 |
| 5 | **ZCode 최신은 4.0.0 (오늘 발표).** 플러그인 기본값 3.15.3은 5개 마이너 + 메이저 1개 뒤처짐. 서버 강제 최소 버전은 3.5.3이라 지금도 동작은 함 | GitHub `zai-org/ZCode` v4.0.0 published 2026-11-23T08:14Z, CDN `releases/4.0.0/macos-arm64/latest.yml` 200, `client/configs.forceUpdate.minimalVersion=3.5.3` |

**권고**: A안(플러그인 내재화)으로 간다. 핵심은 (a) native provider 등록으로 built-in과 같은 모양, (b) 호스트가 안 불러주는 갱신을 확장이 **스스로 트리거** (`ctx.modelRegistry.refresh({allowNetwork:true, providers:["glm-zcode"]})`), (c) live 응답을 단일 source of truth로 두어 **새 모델에 코드 수정 0**. ZCode 4.0.0 정렬은 A와 독립이라 병렬로 가능. B안(senpi 포크 built-in 올리기)은 A 이후 선택.

---

## 1. 배경과 목표

사용자 요구 (원문 요지):

1. 플러그인이 omo와 잘 맞지 않고 엉성하다. **omo에 붙어서 모델 리스트를 바로바로 가져오고 정식 프로바이더처럼 인식되게** 하고 싶다.
2. 새 모델(오늘 GLM-5.4)이 나와도 **바로 적용되지 않는다.**
3. **zcode 최신 버전에 맞춰 업데이트**하고 싶다. 단 "zcode 새 버전은 우리가 따로 따라가면 된다" → 자동 추적보다 **정렬 작업 자체**가 목적.
4. 정식 프로바이더가 아니라서 **가끔 알 수 없는 경고**가 뜬다.

완료 조건 (제안):

- Z.AI가 모델을 추가한 뒤, **플러그인 코드 수정·재설치·재시작 없이** 실행 중인 새 세션의 `/model` 목록에 해당 모델이 보인다 (갱신 주기 이내).
- 새 모델 참조 시 `No models match pattern` 경고가 재현하지 않는다.
- `/login`, `/model` 목록에서 built-in provider와 구분되는 "unofficial" 표기가 UI에는 없다 (경고 문구는 README 유지).
- `ZCODE_APP_VERSION` 기본값과 프로토콜이 ZCode 4.0.0 번들 기준으로 검증된다.
- 기존 제약 유지: `omo.jsonc` 미수정, 실제 모델 추론 요청 없음(오프라인 단위 테스트만), PR 본문에 소유자 이름·로컬 경로 미포함, **런타임 클론 선적용 후 사용자에게 테스트 요청**.

---

## 2. 현재 상태 (팩트)

### 2.1 버전과 위치

| 항목 | 값 | 비고 |
|---|---|---|
| 저장소 HEAD | `31729f1` (PR #15 병합, 2026-10-16) | `main` = `origin/main` |
| 미커밋 변경 | `extensions/glm-zcode/index.ts`에 `glm-5.4` 추가 (`MODELS` 정적 폴백 + `OFFICIAL_GLM_MODEL_IDS`) | **개발 워크스페이스와 런타임 클론 양쪽에 동일하게 존재** (파일 내용 동일 확인) |
| `ZCODE_APP_VERSION` 기본값 | `3.15.3` | User-Agent / `X-ZCode-App-Version` / `X-Client-Version` 공통 |
| 런타임 senpi | `@code-yeongyu/senpi` 2026.11.19-5 (omo 5.1.81 번들, 두 런타임 경로 동일 버전) | `~/.bun/install/global/...` 과 `~/.omo/agent/runtime/<id>/...` 모두 동일 |
| devDependencies | `@code-yeongyu/senpi` **2026.8.29**, `@earendil-works/pi-ai` (senpi-ai 2026.8.29) | 런타임보다 3개월 묵음. 타입(`RefreshModelsContext`, `Provider`)이 달라졌을 수 있음 → 구현 시 재확인 필요 |
| 런타임 클론 | `~/.omo/agent/git/github.com/<owner>/omo-zcode-oauth` (senpi가 로드하는 실제 사본) | 개발 트리만 고치면 런타임은 옛 코드 그대로 |
| 모델 저장소 | `~/.omo/agent/models-store.json` — **현재 `glm-zcode` 엔트리 없음** | 21:23 KST에 사용자가 백업 후 삭제 (`models-store.json.bak-glm54clear-20261123-212327`). 백업 스냅샷은 11개 모델 = 9월 로그인 시점 live 목록 (`glm-5.3-flashx` 포함, `glm-5.4`/`glm-5.3-flashx-legal` 없음) |
| 실행 중 세션 | senpi 프로세스 30+ 개, 최장 **6일 1시간** 경과 | 모듈을 다시 로드하기 전까지 구세대 코드·구세대 레지스트리 유지 |

### 2.2 코드 구성 (변경 대상 중심)

| 파일 | 줄 수 | 역할 | 이번 브리프에서 |
|---|---|---|---|
| `extensions/glm-zcode/index.ts` | 417 | 진입점. `pi.registerProvider("glm-zcode", config)` (레거시 config 경로), `refreshModels` 하이브리드(live→models.dev→stored→정적), off-peak `streamSimple` 래퍼, `before_provider_request`(casing + `metadata.user_id`), `before_provider_headers`(서명), **하드코딩 `MODELS`/`OFFICIAL_GLM_MODEL_IDS`** | **재구성** |
| `extensions/glm-zcode/models.ts` | 272 | models.dev 카탈로그, `CATALOG_TTL_MS = 24h`, thinking 맵, source headers, `zcodeAppVersion()` | TTL/소스 역할 축소, 버전 상수 범프 |
| `extensions/glm-zcode/live-catalog.ts` | 112 | `GET api.z.ai/api/anthropic/v1/models` (Bearer + source headers). `{id, display_name}`만 취함 | **단일 source of truth로 승격**, casing 파생 |
| `extensions/glm-zcode/signing.ts` | 360 | V4 서명(게이트·핸드셰이크·PoW) | 4.0.0 diff 대상, 변경은 diff 결과에 따라 |
| `extensions/glm-zcode/oauth.ts` | 396 | device flow + 콜백 폴백 + 프로비저닝 | 4.0.0 diff 대상 |
| `extensions/glm-zcode/offpeak.ts` | 261 | 옵트인 오프피크 티켓 (앱 3.14+에서 제거된 경로) | 변경 없음 (비-목표) |
| `test/*.test.ts` 10개 | 3,349 | vitest. 137 passed / 1 skipped (PR #15 시점) | native 전환에 맞춰 갱신 |

### 2.3 모델 소스 3종 비교 (2026-11-23 실측)

| 소스 | 결과 | 비고 |
|---|---|---|
| live `GET /api/anthropic/v1/models` + `Bearer <프로비저닝 키>` | HTTP 200, **138 ms**, 13개: `glm-4.5, glm-4.5-air, glm-4.6, glm-4.7, glm-5, glm-5-turbo, glm-5.1, glm-5.2, glm-5.3, glm-5.3-flash, glm-5.3-flashx, glm-5.3-flashx-legal, glm-5.4` | 각 항목 `{id, display_name, created_at, type}`. `display_name`이 공식 표기 (`"GLM-5.4"`, `"GLM-5.3-FlashX-Legal"`) |
| live 동일 경로, 미인증 | HTTP 200 + `{code, msg, success}` 에러 envelope | `data` 배열 없음 → 플러그인은 `[]`으로 처리. **미로그인 상태에서 live는 불가** |
| models.dev `zai-coding-plan` | 8개: `glm-4.7, glm-5-turbo, glm-5.2, glm-5.2-highspeed, glm-5.3, glm-5.3-flash, glm-5.3-highspeed, glm-5.4` (오늘 glm-5.4 반영됨) | 커뮤니티 갱신 주기, 계정 실권한 미반영, `display_name`은 있지만 live와 어휘가 다름 (`*-highspeed`) |

→ live가 **계정 실측 + 공식 표기 + 빠름**이라 단일 source of truth로 쓰고, models.dev는 live 실패 시 메타데이터(context/thinking) 보조로만 남긴다.

---

## 3. 진단 (원인과 근거)

### D1. 호스트가 자동 네트워크 갱신을 하지 않는다 (결정적)

senpi 2026.11.19-5 번들 기준:

- `ModelRuntime.create`는 `modelNetworkEnabled = (OFFLINE 미설정 && options.allowModelNetwork === true)`. 번들 전체에 `allowModelNetwork: true`를 넘기는 호출이 **0개** (전부 `false` 또는 생략). 실제 `ModelRuntime.create` 후 `rt.modelNetworkEnabled` → `false` 확인.
- `ModelRuntime.refresh(options)`는 `allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled` → 생략 시 `false`.
- pi-ai `ModelsImpl.refresh`는 네트워크 단계를 `allowNetwork && credential` 일 때만 실행. 확장의 `refreshModels`는 항상 2단계(restore `allowNetwork:false` → network `allowNetwork:true`)로 호출되는데, 네트워크 단계 자체가 생략된다.

**프로브 (실제 런타임 모듈 import, 로깅용 `refreshModels`를 `glm-zcode` id로 등록, 저장소 쓰기 없음):**

| 호출 경로 | 확장이 받는 context |
|---|---|
| 시작 시 확장 등록 후 `refresh({providers:["glm-zcode"]})` (`agent-session-services.js:121-124`, 등록은 `refresh:false`) | `{allowNetwork:false, credential:"oauth", stored:false}` |
| TUI 시작 후 "background refresh" / `/model` 선택기의 "Refreshing model catalogs…" → `refresh({signal})` (`interactive-mode.js:1350, 6955, 7268` → `model-catalog-refresh.js`) | `{allowNetwork:false, credential:"oauth", stored:false}` |
| `/login` 직후 `refresh({allowNetwork:true, providers})` (`interactive-mode.js:7933`) | restore `{allowNetwork:false}` + **network `{allowNetwork:true, credential:"oauth"}`** |
| `omo update --models` (`package-manager-cli.js:518-545`) | 확장 미로드 → **glm-zcode의 `refreshModels`가 아예 호출되지 않음** |

코드 주석("RPC refreshes catalogs here in the background", `main.js:1385`)은 현실과 어긋난다. built-in provider도 마찬가지로 자동 갱신이 안 되며, `models-store.json`의 `checkedAt`이 9~10월에 머물러 있는 것이 이를 뒷받침한다 (`zai`, `opencode-go`는 `checkedAt=1ms`, `openai-codex`/`xai` 2026-09-23, `kimi-coding` 2026-10-30).

→ **glm-zcode 카탈로그가 네트워크로 바뀌는 유일한 순간 = `/login glm-zcode` 직후.** 그 뒤의 신모델은 영원히 반영되지 않는다. 오늘 21:23에 저장소를 비운 뒤 21:45에 시작한 세션에서도 `glm-zcode` 엔트리가 다시 생기지 않은 것이 직접 증거.

### D2. 플러그인 구조가 수동 갱신을 전제로 한다

| 문제 | 위치 | 결과 |
|---|---|---|
| 정적 폴백 하드코딩 | `index.ts` `MODELS` | 신모델 → 편집 필요 |
| wire casing 맵 하드코딩 | `index.ts` `OFFICIAL_GLM_MODEL_IDS` (ZCode 3.15.3의 22개) | 신모델 → **두 번째** 편집 필요. live `display_name`으로 대체 가능 |
| TTL 24h | `models.ts` `CATALOG_TTL_MS` | built-in은 pi.dev 4h(`REMOTE_CATALOG_REFRESH_INTERVAL_MS`), opengateway 1h. 호스트가 refresh를 안 불러주므로 현재는 무의미하지만, 자체 트리거를 넣으면 이 값이 실질 주기가 됨 |
| 배포 = 두 트리 수동 복사 | 개발 워크스페이스 → `~/.omo/agent/git/.../omo-zcode-oauth` | 오늘도 두 곳에 같은 편집을 반복 |
| README 모순 | "강제 갱신: `omo update --models`" | D1에 의해 glm-zcode에는 거짓 |

### D3. 경고의 정체

- senpi `core/model-resolver.js resolveModelScope()`는 패턴(라우팅 설정의 모델 참조, `--model`, `/model` 스코프)이 `getAvailable()`에 없으면 `console.warn("Warning: No models match pattern ...")`. omo TUI는 stderr를 소유하므로 사용자에게는 "hidden stderr while TUI active"로만 보인다.
- 오늘 기록 (`~/.omo/agent/OmO-debug.log`): 12:45:52 ×3, 12:54:56, 12:55:11 UTC — `glm-zcode/glm-5.4`. 12:45:46에 선택기로 `glm-5.4`로 전환 직후(정적 편집 덕에 이 세션에는 있었음), **레지스트리가 구세대인 다른 프로세스/스코프 평가에서** 발생.
- `No models match`는 D1·D2의 결과이지 별개 결함이 아니다. 카탈로그가 맞춰지면 사라진다.

### D4. "정식 프로바이더"와의 실제 차이

| 항목 | built-in (예: `opengateway`, `kimi-coding`, `zai`) | 현재 glm-zcode |
|---|---|---|
| 등록 형태 | `builtinProviderCatalog.builtinProviders()` → pi-ai `createProvider({...})` + 자체 `getModels/refreshModels` 오버레이 (`providers/opengateway.js`, `opengateway-refresh.js`) | `pi.registerProvider(name, config)` → `provider-composer.composeModelProvider`가 감쌈 |
| 확장 없는 세션 | 항상 존재 (`--list-models`, `omo update --models`, SDK) | 확장이 로드된 세션에만 존재 |
| 표시명 | `BUILT_IN_PROVIDER_DISPLAY_NAMES` (예 `zai: "ZAI Coding Plan (Global)"`) | `"GLM ZCode (unofficial)"` |
| 원천 표기 | `providerOriginOf` → `builtin` | `extension` (RPC `get_provider_origin`로 노출, TUI에는 미표시) |
| 카탈로그 갱신 | pi.dev 원격 오버레이(`withRemoteCatalog`, 4h, etag/304) 또는 자체 `refreshModels` | 자체 `refreshModels` (그러나 D1 때문에 호출 안 됨) |

→ 플러그인만으로 **"확장 없는 세션에도 보이는"** 수준은 불가능(= B안 필요). 나머지(모양·이름·갱신)는 A안으로 built-in과 동등해진다.

### D5. 장수 세션

이미 떠 있는 프로세스(최장 6일)는 모듈을 재로드하기 전까지 A안을 적용해도 옛 코드다. 저장소(`models-store.json`)는 공유되므로, 한 세션이라도 갱신을 수행하면 다른 세션은 자기 다음 `refresh()` 호출(시작, `/model` 열기 등) 때 restore 단계에서 새 목록을 읽는다. 완전한 해결은 세션 재시작.

---

## 4. 설계 A안: 플러그인 내재화 (senpi 변경 없음)

### A1. native provider 등록

`pi.registerProvider(providerObject)` (런타임 `registerNativeProvider`, `types.d.ts`의 `Provider` 오버로드)로 전환. built-in과 동일한 구조:

```
createProvider({ id:"glm-zcode", name:"GLM ZCode", baseUrl: ULTRA_BASE_URL,
                 auth:{ oauth: <adaptOAuth(config.oauth)> }, models: <정적 폴백>,
                 api: <anthropic streamSimple 래퍼(기존 offPeakStreamSimple)> })
  + { getModels: catalog.getModels, getAllModels: catalog.getAllModels, refreshModels: catalog.refresh,
      retryPolicy, filterModels(선택) }
```

- `composeProvider`는 config/models.json 오버레이가 없을 때 native provider를 **그대로** base로 쓴다("use the builtin untouched"). composer의 감싸기(`applyExtension`, `refreshedExtensionModels`)가 빠진다.
- 인증·헤더 합성은 여전히 호스트가 한다: `ModelRuntime.prepareRequest()`가 `getAuth()` 결과 + `options.headers`를 합치고 `transformHeaders`로 `before_provider_headers`를 실행 → **서명·off-peak 훅은 그대로 작동** (provider 종류 무관).
- OAuth 어댑터(`login/refreshToken/getApiKey` → pi-ai `auth.oauth` 형태)는 composer의 `adaptOAuth`와 동일한 10줄 매핑을 플러그인에 둔다. `credentials.registerOAuthProvider`는 `registerNativeProvider`가 처리.
- `refresh:false` 등록 후 시작 시 `refresh({allowNetwork:false, providers})`는 동일하므로 **등록 시점 동작 변화 없음**.

### A2. 카탈로그 모듈 (`catalog.ts`, `opengateway-refresh.js` 패턴)

```
state: current = <stored 복원 | 정적 폴백>
getModels(): current (동기)
refreshModels(context):
  1) context.stored?.models (provider === "glm-zcode") 복원 → publish({ update }) — 거부되면 return
  2) !context.allowNetwork || aborted → return
  3) !context.force && stored.checkedAt + INTERVAL 미만 → return
  4) live = fetchLiveModels(apiKey)  (기존 live-catalog.ts, timeout 30s, 1MB cap, 안전 토큰 검증 유지)
  5) live.length > 0 → merged = live + (models.dev 메타데이터가 있으면 보강)
       publish({ persist:{ models, checkedAt }, update: () => current = merged })
  6) live 실패 → models.dev 경로(기존) → 실패 시 stored/정적 유지 (throw 금지 계약 유지)
```

- `INTERVAL` 제안 **30분** (build-in 최소값 1h보다 짧게; live는 138ms). `CATALOG_TTL_MS=24h`는 제거.
- `persist` 형태는 현재 `catalogToPersistedModels()` 그대로(`ModelsStoreEntry.models[]` + `checkedAt`)라 기존 저장소와 호환.
- 메타데이터 기본값(1M ctx, 131072 max, zero cost, `thinkingLevelMap`, compat)은 유지. models.dev `zai-coding-plan`/`zai`는 **live가 실패했을 때만** 목록 소스로 쓰고, live 성공 시에는 같은 id의 메타데이터 보강에만 쓸 수 있음(선택).

### A3. 자체 갱신 트리거 (핵심)

호스트가 네트워크 갱신을 호출하지 않으므로 확장이 직접 호출한다. `ExtensionContext.modelRegistry` (`types.d.ts:450`, `ModelRegistry.refresh(options) → runtime.refresh(options)`) 사용 — 프로브로 `refresh({allowNetwork:true, providers:["glm-zcode"]})`가 확장 `refreshModels`에 `allowNetwork:true, credential:"oauth"`로 도달함을 확인.

| 트리거 | 시점 | 강제 여부 |
|---|---|---|
| `session_start` | stored 없음 또는 `checkedAt + INTERVAL` 경과 시 1회 (비동기, 세션 차단 없음) | force=false (INTERVAL 게이트) |
| `setInterval(INTERVAL)` | 세션 생존 중 주기적. `timer.unref()`. `OFFLINE` 환경이면 설치하지 않음 | force=false |
| `/glm-models` 명령 | 수동. 현재 목록 + `checkedAt` 출력, 인자 `--force`면 즉시 live | force=true |
| `/login glm-zcode` 직후 | 호스트가 이미 `allowNetwork:true`로 호출 (변경 없음) | — |

- `publish({ update })`가 레지스트리를 그 자리에서 바꾸고 `refresh()`가 `updateModelSnapshot()`을 호출하므로 **실행 중 세션의 `/model` 선택기에 즉시 반영**. 선택기를 다시 열면 보인다.
- 동시 갱신은 pi-ai가 generation으로 직렬화(`supersedeProviderRefresh`) — 마지막 것만 publish.
- 각 호출에 `AbortSignal.timeout(15_000)`을 건다(호스트 관례).

### A4. wire casing 맵 파생

- live 항목의 `display_name`이 공식 표기이므로 `official = display_name` 단, `display_name.toLowerCase() === id.toLowerCase()`일 때만. 아니면 passthrough.
- 맵은 `persist`되는 모델 `name`에서 재구성 가능 → 오프라인 restore 후에도 casing 유지.
- `OFFICIAL_GLM_MODEL_IDS` 상수 삭제. `before_provider_request`의 `payload.model = officialGlmModelId(payload.model)` 로직은 그대로, 맵 소스만 바뀜.
- ZCode 4.0.0 diff(§5)에서 앱의 공식 id 목록이 live `display_name`과 다르면 그때만 예외 테이블을 둔다.

### A5. 표시명

`name: "GLM ZCode"`. "(unofficial)" 경고는 README·`/login` 안내 문구에 유지. `/login` 목록·`/model` 상단에 찍히는 것은 `name`이므로 이것만 바꾸면 built-in과 동일하게 보인다.

### A6. ZCode 앱 버전 처리

- 상수는 §5 diff 후 **4.0.0**으로 범프 (기존 PR #14/#15 패턴: `zcodeAppVersion()` 기본값 + `test/source-headers.test.ts`, `test/signing.test.ts` 버전 고정분, README).
- 런타임 자동 탐지는 **서버에 마땅한 소스가 없다**: `GET zcode.z.ai/api/v1/client/configs?app_version=&platform=` 은 `forceUpdate.minimalVersion=3.5.3`만 주고 "latest" 필드가 없다. 대안 두 가지:
  1. `scripts/check-zcode-version.mjs` (신규): GitHub Releases API(`zai-org/ZCode`) + CDN `latest.yml`을 찍어 현재 상수와 비교, 뒤처지면 종료코드 1 + 요약 출력. 수동/CI 실행.
  2. (선택) 설치된 데스크톱 앱 `Info.plist`의 `CFBundleShortVersionString`이 있으면 우선 — 이 머신(Linux)에는 앱이 없고, 앱이 있는 Mac에서는 자동 추적이 된다. 사용자가 "수동 추적"이라 했으므로 1번만 먼저.
- `ZCODE_APP_VERSION` env override는 그대로.

### A7. devDependency 정렬

`@code-yeongyu/senpi` / `@earendil-works/pi-ai`를 2026.11.19-5로 올려 런타임 타입과 맞춘다. 특히 `Provider`, `RefreshModelsContext`, `OAuthCredentials` 시그니처를 구현 전에 대조. 테스트는 여전히 오프라인(mock fetch)만.

### A안 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `extensions/glm-zcode/index.ts` | `registerProvider(name, config)` → `registerProvider(provider)`; `MODELS`·`OFFICIAL_GLM_MODEL_IDS` 삭제; 자체 트리거(`session_start`, `setInterval`, `/glm-models`) 추가; 훅·off-peak 래퍼·`getApiKey` JWT 캐시는 유지 |
| `extensions/glm-zcode/catalog.ts` (신규) | A2 상태 머신 (`createZCodeCatalog`) |
| `extensions/glm-zcode/live-catalog.ts` | `display_name` 기반 casing 맵 노출, 메타데이터 기본값 유지 |
| `extensions/glm-zcode/models.ts` | `CATALOG_TTL_MS` 제거 → `CATALOG_REFRESH_INTERVAL_MS`; models.dev는 보조; `zcodeAppVersion()` 기본값 4.0.0 |
| `extensions/glm-zcode/signing.ts`, `oauth.ts` | §5 diff 결과에 따라 (변경 없을 수 있음) |
| `scripts/check-zcode-version.mjs` (신규) | A6-1 |
| `test/*` | native 등록 형태로 갱신, 자체 트리거 테스트(가짜 타이머, stub fetch, 저장소 쓰기 assert), casing 파생 테스트, 기존 137개 유지 |
| `README.md` | `update --models` 주장 정정, 갱신 주기·`/glm-models`·트리거 설명, 버전 4.0.0 |
| `package.json` | devDependency 범프 |

---

## 5. ZCode 4.0.0 정렬 범위

### 5.1 버전 타임라인 (macOS CDN `latest.yml` + GitHub Releases)

| 버전 | CDN releaseDate (UTC) | GitHub Release | 비고 |
|---|---|---|---|
| 3.15.3 | 2026-10-16 | — | **현재 기본값** (PR #15) |
| 3.16.1 / 3.16.2 / 3.16.3 | 2026-10-17 ~ | — | |
| 3.17.1 | 2026-10-30 | 2026-10-30 | |
| 3.17.2 | 2026-11-04 | 2026-11-04 | |
| 3.18.0 / 3.18.1 / 3.18.2 | 2026-11-12 ~ | 3.18.2: 2026-11-16 | `minimumSystemVersion: 22.0.0` 시작 |
| 3.19.0 / 3.19.1 | 2026-11-19 / 2026-11-20 | — | |
| **4.0.0** | **2026-11-22T11:43Z** | **2026-11-23T08:14Z** (build `6d86cdaa…`) | 메이저. CDN release notes: 지역별 플러그인 스토어, 설정 서비스 불능 시 워크플로 온디맨드 활성, 문서/시트/프레젠트 플러그인의 추가 시각 검수 단계 제거. **프로토콜 변경 언급 없음** → 번들로 검증 필요 |

- 아티팩트: `cdn-zcode.z.ai/zcode/electron/releases/4.0.0/macos-arm64/ZCode-4.0.0-mac-arm64.zip` (305,610,968 B, sha512 `KCz2AO…EqA==`, latest.yml 기재). GitHub 릴리스에는 SHA256SUMS 첨부.
- 서버 강제 최소 버전: `client/configs.forceUpdate.minimalVersion = 3.5.3` → 3.15.3 헤더로도 지금 동작 중 (오늘 glm-5.3/glm-5.4 요청이 529/500 서버 오류만 받고 인증 거부는 없음).

### 5.2 검증 체크리스트 (3.15.3 → 4.0.0)

| # | 항목 | 기대(3.15.3 기준) | 소스 |
|---|---|---|---|
| Z1 | ClientRequestSigningV4: 핸드셰이크 `POST /api/paas/c1f3a7e2/v2/client`, KDF 라벨(`WD_CLIENT_SIGN_KDF_SALT`, `getSignKey_hmac`, `ed25519_priv`), Ed25519 서명문 `{id}\n{ts}\n{version}\n{sessionId}\n{nonce}`, PoW 8bit, `X-Client-*`/`X-App-Id`/`X-Session-Id`, fail-open 코드 | 동일 | 오픈소스 **`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`** ← 3.14.4 시점엔 미공개였던 V4 코드가 소스 트리에 있음. 번들 `Resources/glm/zcode.cjs`로 교차 확인 |
| Z2 | 게이트 `GET /api/v1/agent/configs` (`codingPlanSignature.enable`, `proxyEndpoint.mapping`) | 동일 또는 필드 소멸(3.15.3 앱은 이미 미참조) | `adapters/src/model/model-request-headers.ts`, `runner-network-headers.ts`, `runner-runtime-headers.ts` |
| Z3 | ultra 게이트웨이 라우팅 `api.z.ai/api/anthropic/v1/messages → zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages` | 동일 | `adapters/src/model/official-coding-plan-gateway.ts` |
| Z4 | 소스 헤더 집합 (`X-ZCode-Agent: glm`, `X-ZCode-App-Version`, `X-Release-Channel`, `X-Platform`, `X-Os-Category`, `X-Os-Version`, `X-Client-Language`, `X-Client-Timezone`, `X-Title`, `HTTP-Referer`) | 동일 | `bootstrap/src/provider-endpoint-routing-source-headers.ts`, `runtime-platform-headers.ts`, `zcode-protocol/provider-runtime-headers.ts`, `core/src/runtime/methods/model-runtime-headers.ts` |
| Z5 | User-Agent 접미사 `ai-sdk/provider-utils/x.y.z runtime/node.js/<ver>` — `@ai-sdk/anthropic` 버전에 의존 | 4.0.0의 lockfile에서 재계산 | `apps/zcode-cli/package.json`, lockfile |
| Z6 | `metadata.user_id = JSON({device_id, account_uuid:"", session_id})` | 동일 | `adapters/src/device/cli-device-mid.ts`, 번들 anthropic 경로 |
| Z7 | OAuth device flow: `cli/init`, `cli/poll/{flowId}`(GET), client id, `zcode.z.ai/api/v1/oauth/token`, `data.token` JWT, 콜백 폴백 `zcode://oauth/callback` | 동일 | `adapters/src/auth/cli-oauth.ts`, `bigmodel-oauth.ts`, `coding-plan-api-key.ts` |
| Z8 | 공식 모델 id 표기·목록 | live `display_name`과 일치하는지 (A4 전제) | 번들 `normalizeOfficialGlmModelId` 해당 분석 + live |
| Z9 | 오프피크 (앱 3.14+에서 제거된 티켓 경로) | 계정-오프피크 프로바이더 모드인지 재확인. 플러그인 `offpeak.ts`는 옵트인 유지, 변경 없음 | `core/src/runtime/off-peak/*`, `contracts/src/tools/off-peak.ts` |
| Z10 | CAPTCHA(3007, Aliyun) 레이어 — openai-compatible 경로 전용이었음 | 서명 anthropic 경로에 확대됐는지 | 번들 grep |
| Z11 | 최소 버전·다운그레이드 차단 | `minimalVersion` 3.5.3 → 변동 시 노트 | `client/configs` |

### 5.3 방법

1. `git clone --depth 1 --branch v4.0.0 https://github.com/zai-org/ZCode` → 체크리스트 Z2~Z7, Z9를 소스에서 직접 대조 (PR #15 때는 번들 RE였음 — 이번엔 소스가 우선).
2. CDN zip 다운로드 → sha512 대조(latest.yml) → unzip → asar 추출(`bunx @electron/asar extract`) → `Resources/glm/zcode.cjs`에서 Z1·Z5·Z6·Z8·Z10 심볼 grep (V4 KDF 라벨, `provider-utils/`, `metadata`, `normalizeOfficialGlmModelId`, `x-aliyun-captcha`).
3. 결과물: `docs/research/zcode-3.15.3-to-4.0.0-protocol-diff.md` (기존 `zcode-3.14.4-protocol-diff.md` 형식: Unchanged / Changed / Conclusion) + 코드 반영 + 테스트.
4. 증거 규칙: **오프라인 단위 테스트만.** 모델 추론 요청 금지. 카탈로그 GET(`/v1/models`)은 플러그인이 평소 하는 요청이라 허용.

---

## 6. 작업 순서

| 단계 | 내용 | 산출물 | 검증 |
|---|---|---|---|
| 0. 핫픽스 정리 | 오늘의 미커밋 `glm-5.4` 편집은 A4/A2가 두 리스트를 삭제하므로 **A에 흡수**. 런타임 클론의 핫픽스는 A가 런타임에 적용될 때까지 유지(임시) | — | — |
| 1. ZCode 4.0.0 diff (A와 병렬) | §5.3 | diff 문서, `ZCODE_APP_VERSION=4.0.0`, 헤더/서명 테스트 갱신 | vitest, tsc |
| 2. devDependency 범프 (A7) | senpi/pi-ai 2026.11.19-5, 타입 대조 | `package.json` | tsc |
| 3. A1+A2 catalog.ts | native 등록 + 상태 머신 | `catalog.ts`, `index.ts` | 단위 테스트(가짜 fetch/저장소) |
| 4. A3 트리거 | `session_start`/`setInterval`/`/glm-models` | `index.ts` | 가짜 타이머 테스트, "allowNetwork:true로 도달" 어설션 |
| 5. A4+A5 | casing 파생, 표시명 | `live-catalog.ts`, `index.ts` | 모델-id 테스트 갱신 |
| 6. README | `update --models` 정정, 주기·명령·버전 | `README.md` | 문서 정합 |
| 7. 전체 게이트 | vitest 1회, tsc, 기존 137개 유지 | — | green |
| 8. **런타임 선적용** | 개발 트리 → `~/.omo/agent/git/.../omo-zcode-oauth` 동기화 (**사용자에게 테스트 요청 전에 반드시**) | — | `diff -r` 0 |
| 9. 사용자 확인 | **새 세션**에서 `/model`: `glm-5.4` 포함 13개 표시, 30분 내 자동 갱신, `/glm-models` 동작, `No models match` 미재현 | — | 사용자 |
| 10. PR | feat 브랜치, 리뷰 승인 후 **머지 전 정지** (사용자 지시 대기) | PR | — |

예상 규모: 코드 ~400줄 변경(그중 삭제 ~60줄 하드코딩), 테스트 ~200줄 추가/갱신, 문서 2건.

---

## 7. B안 (후속 선택): senpi 포크에 fork-only built-in으로 올리기

- 전례: `kimi-coding`, `cursor-cli-oauth`, `alibaba-token-plan`, `opengateway`, `xiaomi-token-plan-*` — 모두 `BUILT_IN_PROVIDER_DISPLAY_NAMES` + (일부) `FORK_ONLY_BUILTIN_PROVIDERS`.
- 효과: 확장 없는 세션·`omo update --models`·`--list-models`·SDK에도 보임 = **진짜 "정식"**. `signing.ts`/`oauth.ts`/카탈로그가 senpi(pi-ai providers)로 이동.
- 비용: senpi 릴리스 주기 종속(ZCode 프로토콜 변경 때마다 senpi 릴리스 필요), 포크 소유자 리뷰/PR, 플러그인은 얇은 레이어 또는 제거.
- 판단: A가 끝난 뒤 "확장 없는 세션에서도 보여야 한다"는 요구가 남으면 진행. 지금은 아님.

---

## 8. 범위 밖 (Non-goals)

- `~/.omo/omo.jsonc`(라우팅 설정) 수정 없음.
- `offpeak.ts` 변경 없음 (옵트인, 앱 3.14+에서 제거된 경로).
- 실제 모델 추론 요청 없음 — 카탈로그 GET만.
- senpi 포크 변경 없음 (A안), upstream PR 없음.
- 이미 실행 중인 세션의 핫 리로드 없음 — 재시작으로 해결.
- `omo update --models`가 glm-zcode를 포함하게 만드는 것 — 호스트 제약이라 A로는 불가(B안 범위). README에 명시.

---

## 9. 리스크와 한계

| 항목 | 내용 | 대응 |
|---|---|---|
| 장수 세션 | 6일 된 프로세스는 옛 모듈 | 재시작 안내. 저장소 공유로 다른 세션의 다음 restore 때 새 목록 반영 |
| `update --models` 공백 | 여전히 glm-zcode 제외 | README 정정 + `/glm-models --force` 제공 |
| 자체 `setInterval` | 세션당 30분마다 138ms GET | `unref`, `OFFLINE` 시 미설치, 세션 종료 이벤트 있으면 해제 |
| native 경로의 인증 합성 | composer를 거치지 않음 | `prepareRequest`가 여전히 `getAuth`+`transformHeaders` 수행 — 라이브 훅이 그대로 적용됨을 단위 테스트로 고정 |
| `models.json` 오버레이 | 사용자가 `glm-zcode`를 models.json에 정의하면 composer 오버레이가 다시 개입 | 현재 사용자 `models.json`에 `glm-zcode` 없음 확인. 문서에 noted |
| live 미인증 200 | `data` 없는 에러 envelope | 기존 검증(`data` 배열 필요) 유지 |
| 4.0.0 메이저 | 프로토콜 변경 가능성 | §5 체크리스트로 번들 검증 후 범프. diff 없으면 상수만 |
| devDependency 범프 | 테스트 타입 깨짐 가능 | 2단계에서 tsc로 조기 발견 |

---

## 10. 확인이 필요한 결정

1. 갱신 주기 `INTERVAL` = **30분**으로 갈지 (대안: 15분 / 60분).
2. 표시명 **"GLM ZCode"**로 갈지.
3. 오늘의 미커밋 핫픽스를 A에 **흡수**(별도 커밋 안 함)할지.
4. devDependency를 런타임과 같은 **2026.11.19-5**로 올릴지.
5. ZCode 4.0.0 diff를 A와 **병렬**로 진행할지, A 먼저 할지.
6. B안은 이번 범위에서 **제외**하는지.

---

## 11. 참조

- 저장소 문서 규격: `docs/research/pr7-hybrid-live-catalog-definition.md`, `docs/research/pr8-ultra-signing-definition.md`, `docs/research/zcode-3.14.4-protocol-diff.md`
- senpi 런타임 참조 (2026.11.19-5): `dist/core/model-runtime.js` (`create`, `refresh`, `registerProvider`, `registerNativeProvider`, `shouldSkipRegistrationRefresh`, `refreshAfterRegistration`, `prepareRequest`), `dist/core/agent-session-services.js:95-125`, `dist/core/provider-composer.js` (`composeModelProvider`, `adaptOAuth`), `dist/core/remote-catalog-provider.js` (`withRemoteCatalog`, 4h), `dist/core/model-resolver.js` (`resolveModelScope` 경고), `dist/core/extensions/types.d.ts:450, 2467-2505` (`modelRegistry`, `registerProvider(Provider)`), `dist/modes/interactive/interactive-mode.js:1350, 6955, 7268, 7933`, `dist/package-manager-cli.js:518-545`, `@earendil-works/pi-ai/dist/models.js` (`ModelsImpl.refresh`, `runProviderRefreshPhase`), `providers/opengateway.js` + `opengateway-refresh.js` (패턴)
- 로그/상태: `~/.omo/agent/OmO-debug.log` (경고 5건), `~/.omo/agent/logs/session.log` (`model_change` 12:45:46Z, `provider_error` 529/500), `~/.omo/agent/models-store.json` (+ `.bak-glm54clear-20261123-212327`), `~/.omo/agent/auth.json` (`glm-zcode` oauth, `expires` 2036-09-20, `zcodeJwtToken` 있음)
- ZCode: GitHub `zai-org/ZCode` tags `v4.0.0`, `v3.18.2`, `v3.17.2`, `v3.17.1`, `v3.15.1`, `v3.14.3`; CDN `releases/{3.16.1,3.16.2,3.16.3,3.17.1,3.17.2,3.18.0,3.18.1,3.18.2,3.19.0,3.19.1,4.0.0}/macos-arm64/latest.yml` 200
- 이전 정렬 기록: PR #14 (3.14.4), PR #15 (3.15.3: 공식 id wire 재작성, 서명 fail-open, 버전)
