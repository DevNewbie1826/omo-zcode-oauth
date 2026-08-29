# zcode OAuth → omo(pi) 확장 가능성 조사 보고서

조사일: 2026-08-29 · 조사 범위: 구현 전 feasibility 조사 (코드 작성 없음)

## 결론 (TL;DR)

**가능하다. omo/pi 코어 패치 없이, 순수 외부 확장(extension) 하나로 만들 수 있다.**

- senpi PR #295의 코드가 이미 공개 ExtensionAPI(`pi.registerProvider` + `ProviderConfig.oauth`)만 사용하도록 작성되어 있다. in-tree builtin이라는 것만 빼면 외부 확장과 동일한 형태다.
- 현재 설치된 omo-ai 5.0.0-beta.26 → @code-yeongyu/senpi 2026.8.28-2에 해당 API가 이미 포함되어 있다 (PR 미머지여도 외부 확장으로 동일 기능 탑재 가능).
- 패키징은 `package.json`의 `pi` manifest + `extensions/` 디렉토리 관례를 따르고, `omo install git:...` / `omo install ./path` 로 설치한다.

---

## 1. zcode OAuth란 무엇인가 (두 소스 분석)

ZCode 데스크톱 앱이 Z.AI 로그인을 GLM 모델 접근으로 바꾸는 방식을 재현한 **비공식(unofficial) OAuth 플로우**. 최종 산출물은 OAuth 토큰이 아니라 **Z.AI 대시보드 API 키**(`"{apiKeyId}.{secretKey}"`)이며, 이 키로 `https://api.z.ai/api/anthropic` (Anthropic 호환 엔드포인트)에 Bearer 인증한다.

### 플로우 (양쪽 소스 동일)

1. **Authorize**: `GET https://chat.z.ai/api/oauth/authorize?redirect_uri=zcode://oauth/callback&response_type=code&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&state=<uuid>`
   - redirect가 커스텀 프로토콜(`zcode://`)이라 CLI가 받을 수 없음 → **사용자가 최종 리다이렉트 URL을 수동 붙여넣기**
   - **PKCE 없음** (upstream이 검증된 PKCE를 지원하지 않음 — PR 본문 security note)
2. **Broker 교환**: `POST https://zcode.z.ai/api/v1/oauth/token` `{ provider: "zai", code, redirect_uri, state }` → `data.zai.access_token` (upstream Z.AI 토큰)
3. **Business 로그인**: `POST https://api.z.ai/api/auth/z/login` `{ token: <upstream> }` → `data.access_token` (business 토큰)
4. **API 키 프로비저닝** (business 토큰으로):
   - `GET /api/biz/customer/getCustomerInfo` → 기본 organization/project
   - `GET/POST /api/biz/v1/organization/{org}/projects/{proj}/api_keys` → `zcode-api-key` 이름 키 조회/생성
   - `GET .../api_keys/copy/{id}` → `secretKey` ⇒ 최종 키 `"{id}.{secretKey}"`

### Credential 매핑

| 필드 | 값 |
|---|---|
| `access` | 프로비저닝된 Z.AI API 키 (`{id}.{secret}`) — `getApiKey: c => c.access` |
| `refresh` | upstream Z.AI OAuth access token (재프로비저닝용) |
| `expires` | gajae-code: 10년 고정(키 장기유효) / senpi PR: now+55분(주기적 재프로비전) |

### 소스별 차이

| | gajae-code (원본) | senpi PR #295 (포팅) |
|---|---|---|
| 파일 | `packages/ai/src/utils/oauth/glm-zcode.ts` (433줄) + 테스트 | `packages/coding-agent/src/core/extensions/builtin/glm-zcode/oauth.ts` (169줄) + 테스트 133줄 |
| 엔드포인트 | `ZCODE_OAUTH_*` env로 override 가능 | **고정** (보안 의도 — 테스트가 `ZCODE_OAUTH_BROKER_TOKEN_URL=attacker.invalid` 미적용을 검증) |
| 콜백 검증 | `parseCallbackInput` (code만 추출 가능) | 엄격: 프로토콜/호스트/경로 고정, code·state 정확히 1개, state 일치, malformed는 교환 전 reject |
| identity | userinfo API + JWT 디코드 fallback | getCustomerInfo의 email/id만 |
| 에러 | secret redaction (`[redacted-jwt]`) | 응답 바디 미에코 |
| 만료 | 10년 고정 (`GLM_ZCODE_API_KEY_TTL_MS`) | 55분 재프로비전 (`REPROVISION_INTERVAL_MS`) |
| 기반 클래스 | `OAuthCallbackFlow` (gajae 자체 프레임워크) | 없음 — pi-ai `OAuthLoginCallbacks`에 직접 매핑 |

**확장으로 가져갈 코드는 senpi PR #295 쪽이 적합** — pi-ai 콜백 인터페이스에 이미 맞춰져 있고, gajae의 `OAuthCallbackFlow` 기반 클래스 의존이 없다. gajae 쪽에서 가져올 만한 것은 secret redaction과 30s 타임아웃 정도.

## 2. pi/omo 확장 API 표면 (auth 관련)

### 핵심 API: `pi.registerProvider(name, config)`

설치된 senpi `dist/core/extensions/types.d.ts`:

- L1432-1433: `registerProvider(provider: Provider): void; registerProvider(name: string, config: ProviderConfig): void;`
- `ProviderConfig.oauth` (L1490 부근):

```typescript
oauth?: {
    name: string;
    isSubscription?: boolean;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    modifyModels?(models, credentials): Model<Api>[];
}
```

- `OAuthLoginCallbacks` (pi-ai `dist/compat/extension-oauth-types.d.ts`): `onAuth({url, instructions})`, `onDeviceCode`, `onPrompt({message})`, `onProgress?`, **`onManualCodeInput?()`** (PR #295가 사용), `onSelect`, `signal?`
- `OAuthCredentials`: `{ access, refresh, expires, email?, accountId? }` → `~/.omo/auth.json`에 provider별 저장 (기존 `kimi-coding`, `openai-codex` 엔트리와 동일 스키마)

### /login 통합

`docs/custom-provider.md` L299-363: "Add OAuth/SSO authentication that integrates with `/login` … After registration, users can authenticate via `/login corporate-ai`." — 확장이 등록한 oauth provider는 TUI `/login` 커맨드에 자동으로 나타난다.

### 확장 엔트리 포맷과 설치

- 엔트리: `export default function (pi: ExtensionAPI): void | Promise<void>` (`docs/extensions.md` L67). senpi가 jiti를 번들하므로 TS 파일도 로딩 가능.
- 패키지: `package.json`에 `"pi": { "extensions": ["./extensions"] }` manifest 또는 관례 디렉토리 자동 발견 (`docs/packages.md`).
- 설치: `omo install npm:<pkg>` / `omo install git:github.com/user/repo` / `omo install ./local/path` — pi install과 동일 스펙. `-l`로 프로젝트 로컬 설치 가능.
- 참고 예제: senpi repo `examples/extensions/custom-provider-anthropic/`, `custom-provider-gitlab-duo/`

### 판정 근거 요약

PR #295의 `index.ts`가 하는 일은 `pi.registerProvider("glm-zcode", {...})` 단 한 번뿐이고, 이 API는 builtin 전용이 아니라 모든 확장에 노출된 공개 API다. 따라서 **동일 코드를 외부 확장 파일로 옮기면 코어 수정 없이 동작**한다.

## 3. 구현 시 형태 (참고용 스케치)

```
zcode-oauth-extension/
├── package.json          # { "keywords": ["pi-package"], "pi": { "extensions": ["./extensions"] } }
└── extensions/
    └── glm-zcode/
        ├── index.ts      # PR #295의 index.ts 그대로 (registerProvider 호출)
        └── oauth.ts      # PR #295의 oauth.ts 그대로 (import만 "@earendil-works/pi-ai/compat" 유지)
```

- `omo install git:github.com/<you>/zcode-oauth-extension` 또는 로컬 경로 설치 → `/login glm-zcode` → 모델 선택 `glm-zcode/glm-5.2`
- 의존성 주의: 확장에서 `@earendil-works/pi-ai` 타입 import는 type-only이므로 런타임 의존 없음. 런타임은 `fetch`/`crypto` (Node 18+)만 사용.

## 4. 리스크 / 주의사항

1. **비공식 플로우**: ZCode/Z.AI ToS 위반 가능성, 언제든 끊길 수 있음 (양쪽 소스 모두 명시). PKCE 없음 — 콜백 URL 유출 주의 안내 필요.
2. **PR #295 미머지(OPEN)**: upstream senpi에 머지되면 builtin으로 들어와 외부 확장과 provider id(`glm-zcode`)가 충돌할 수 있음. 그때는 확장 제거하거나 id 변경.
3. **refresh 동작 차이**: senpi PR 방식(55분 재프로비전)은 Z.AI 측 api_keys에 `zcode-api-key`를 재사용/재생성하므로 계정에 키가 남는다. gajae 방식(10년 고정)은 재프로비전을 거의 안 하지만 upstream 토큰 만료 시 재로그인 필요.
4. **provider id 공존**: 사용자 auth.json에 이미 `zai`(API key)가 있음. `glm-zcode`는 별도 provider id라 공존 가능. 기존 `zai/glm-5.2`(대시보드 키)와 `glm-zcode/glm-5.2`(OAuth 프로비저닝)가 나란히 보일 것.
5. **수동 붙여넣기 UX**: `zcode://` 커스텀 프로토콜이라 브라우저에서 "앱으로 열기"가 뜨고, 개발자도구/주소창에서 최종 URL을 복사해야 한다. `onManualCodeInput`/`onPrompt` 콜백이 이 UX를 담당.

## 증거 파일

- `reference/pr295.diff` — senpi PR #295 전체 diff (423줄)
- `reference/gajae-glm-zcode.ts` — gajae-code 원본 구현 (433줄)
- 설치된 senpi 타입: `.../node_modules/@code-yeongyu/senpi/dist/core/extensions/types.d.ts` L1432, L1462-1510
- pi-ai OAuth 타입: `.../node_modules/@earendil-works/pi-ai/dist/compat/extension-oauth-types.d.ts`
- 문서: senpi `docs/custom-provider.md` (OAuth Support 섹션), `docs/packages.md`, `docs/extensions.md`
