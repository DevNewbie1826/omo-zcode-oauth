# 이상 상태 정의 (Ideal State Definition)

작성일: 2026-08-29 · 근거: 병렬 explore 4개 + 선행 조사 보고서

---

## 1. 현재 문제 상황 (Current State)

| 항목 | 상태 | 근거 |
|---|---|---|
| 원격 레포 | 공개, **비어 있음** (커밋 0) | `gh repo view` → `isEmpty: true` |
| 로컬 클론 | `main`에 조사 베이스라인 1커밋 (`95ca950`) | git log |
| omo 설치 | v5.0.0-beta.26, senpi 2026.8.28-2 | `omo --version` |
| senpi PR #295 | **OPEN, 미머지** — builtin으로만 존재 | gh pr view |
| gajae-code | 원본 구현 존재, 별도 프레임워크 의존 | gajae-glm-zcode.ts |
| 사용자 auth.json | `zai`(API key) 이미 존재 | ~/.omo/auth.json |
| **핵심 갭** | zcode OAuth를 **설치 가능한 독립 확장**으로 쓸 수 없음 | — |

## 2. 이상 상태 (Ideal End State)

**"사용자가 `omo install git:github.com/DevNewbie1826/omo-zcode-oauth` 한 줄로 설치하고, `/login glm-zcode`로 Z.AI OAuth 로그인하여 `glm-zcode/glm-5.2` 모델을 사용할 수 있다."**

### 구체적 완료 조건

1. **패키지**: npm/git 설치 가능한 독립 패키지 — `package.json`에 `pi` manifest, `extensions/glm-zcode/{index,oauth}.ts`
2. **기능**: `pi.registerProvider("glm-zcode", {...})` — baseUrl `https://api.z.ai/api/anthropic`, api `anthropic-messages`, 모델 `glm-5.2` (1M ctx, 131072 max)
3. **OAuth**: `login` → authorize → 수동 붙여넣기 → broker → z/login → 프로비저닝 → `access={id}.{secret}`; `refreshToken` → 저장된 upstream 토큰으로 재프로비전
4. **품질**: typecheck 통과, vitest 테스트 통과 (등록/정상플로우/malformed/refresh에러), README에 설치·사용·경고 문서
5. **프로세스**: feat 브랜치 워크트리에서 개발 → PR → ultrabrain 리뷰 ↔ deep 수정 반복 → 승인 → main 병합

## 3. 의사결정 포인트 (Evidence-based)

| # | 결정 | 선택지 | 근거 | 결정값 |
|---|---|---|---|---|
| D1 | **expires 전략** | 55분 재프로비전 (senpi) vs 10년 고정 (gajae) | senpi: 토큰 위생 좋지만 Z.AI API 빈번 호출. gajae: 키 장기유효하지만 upstream 토큰 만료 시 재로그인 필요. PR #295가 senpi 채택. | **55분 (senpi)** — PR이 검증한 방식, refresh 로직 이미 구현됨 |
| D2 | **env override** | 7개 `ZCODE_OAUTH_*` 전부 (gajae) vs 하드코딩 (senpi) | senpi는 보안 의도로 하드코딩 + 테스트로 검증. 확장은 테스트 가능성이 중요. | **하드코딩 기본 + 테스트에서만 주입 가능한 구조** (senpi 방식 채택, 테스트는 mock fetch로) |
| D3 | **secret redaction** | gajae `redactSecrets()` vs senpi 상태코드만 | senpi가 더 안전(응답 바디 미에코). gajae는 redaction하지만 바디를 에코. | **senpi 방식** — 에러에 상태코드만, 바디 미포함 |
| D4 | **요청 timeout** | gajae 30초 명시 vs senpi signal만 | gajae가 더 견고. signal 없으면 무한 대기 가능. | **30초 timeout 추가** (gajae에서 차용, `AbortSignal.timeout(30_000)`) |
| D5 | **콜백 검증** | senpi `callbackCode()` (엄격, 사전 네트워크 거부) vs gajae `parseCallbackInput` (관대) | senpi가 malformed를 교환 전에 차단. 테스트로 검증됨. | **senpi `callbackCode()`** — 프로토콜/호스트/경로 고정, code·state 정확히 1개, state 일치 |
| D6 | **identity 해결** | senpi getCustomerInfo만 vs gajae userinfo+JWT fallback | senpi가 단순하고 충분. gajae의 JWT 디코드는 복잡도만 증가. | **senpi 방식** — getCustomerInfo의 email/id만 |
| D7 | **OAuthCallbackFlow 의존** | gajae 기반 클래스 vs senpi 직접 콜백 | gajae의 `OAuthCallbackFlow`는 `zcode://` 커스텀 프로토콜이라 로컬 서버가 무의미 (vestigial). | **의존 제거** — senpi의 `OAuthLoginCallbacks` 직접 매핑 |
| D8 | **패키지 형식** | 단일 파일 vs 디렉토리 | pi 패키지 관례: `extensions/` 디렉토리 + `package.json` pi manifest | **`extensions/glm-zcode/{index,oauth}.ts`** + `package.json`에 `"pi": {"extensions": ["./extensions"]}` |
| D9 | **타입 import** | senpi 내부 경로 vs pi-ai compat | PR #295는 senpi 내부 `../../types.ts` 사용. 독립 확장은 공개 패키지에서 import 필요. | **type-only import from `@earendil-works/pi-ai/compat`** (런타임 의존 없음) + ExtensionAPI는 런타임 파라미터로 받음 |
| D10 | **provider id** | `glm-zcode` vs 다른 이름 | PR #295와 동일하게 `glm-zcode` — senpi builtin과 충돌 가능하지만 미머지 상태. | **`glm-zcode`** — PR 머지 시 그때 대응 |

## 4. 위험 및 완화

| 위험 | 영향 | 완화 |
|---|---|---|
| 비공식 플로우 ToS 위반 | 서비스 중단 | README + 로그인 안내 문구에 명시 (양쪽 소스 모두 보존) |
| PKCE 없음 | 콜백 URL 유출 시 코드 탈취 가능 | 안내 문구에 "keep the final zcode:// redirect URL private" 명시 |
| senpi PR 머지 시 id 충돌 | builtin과 확장이 같은 `glm-zcode` 등록 | README에 "upstream 머지 시 이 확장 제거" 안내 |
| Z.AI API 변경 | 플로우 파괴 | 각 단계별 명확한 에러 메시지 + 재로그인 안내 |
| 수동 붙여넣기 UX | 사용자 실수 가능 | `onManualCodeInput` 우선, `onPrompt` fallback, 명확한 instructions |

## 5. 검증 계획 요약

| 기준 | 시나리오 | 증거 |
|---|---|---|
| C001 (happy) | vitest: mock ExtensionAPI로 registerProvider 호출 검증 + mock fetch로 전체 OAuth 플로우 검증 | `.omo/ulw-loop/evidence/C001-*.txt` |
| C002 (edge) | vitest: malformed 콜백 4종 거부 + refresh 실패 시 재로그인 안내 | `.omo/ulw-loop/evidence/C002-*.txt` |
| C003 (regression) | `omo install ./pkg` → `omo list` → `omo --list-models glm-zcode` + `omo auth check --provider zai` | `.omo/ulw-loop/evidence/C003-*.txt` |

---

*이 문서는 mass-ulw DAG 설계의 입력이다. 각 구현 노드는 위 결정값을 그대로 따른다.*
