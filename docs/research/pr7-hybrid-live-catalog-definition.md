# PR #7 이상 상태 정의: 하이브리드 라이브 모델 카탈로그

작성일: 2026-09-04 · 근거: 실계정 라이브 프로브 (2026-09-04, zai 클래스 Z.AI API 키) + pi-ai 타입 사실 + 사용자 확정 설계

---

## 1. 현재 문제 상황 (Current State)

PR #2 이후 `glm-zcode`의 `refreshModels`는 models.dev `api.json`의 `zai-coding-plan` 스냅샷만 소스로 쓴다. 두 가지 구조적 문제가 있다.

| 항목 | 상태 | 근거 |
|---|---|---|
| 신모델 반영 지연 | Z.AI가 새 GLM 모델을 낼 때마다 models.dev의 3rd-party 스냅샷 갱신을 기다려야 함. 갱신 주기는 우리가 통제 불가 | PR #2 정의 문서 (P1: 카탈로그 소스가 models.dev) |
| 계정 실권한과 불일치 | models.dev 목록은 "플랜이 이론상 지원하는 모델"이지 "이 계정 키가 실제로 쓸 수 있는 모델"이 아님. 계정/플랜별 권한 차이가 반영되지 않아 선택 가능 모델과 실제 호출 가능 모델이 어긋남 | 프로브: 프로비저닝 키로 `/v1/models` 호출 시 계정 실측 목록(~15개, glm-4.5..glm-5.x) 반환 확인 (아래 §3) |

## 2. 이상 상태 (Ideal End State)

**"glm-zcode 로그인 후 refreshModels는 프로비저닝된 Z.AI API 키로 계정 실측 카탈로그를 우선 조회하고, 실패 시 기존 models.dev 경로와 저장/정적 폴백을 그대로 유지한다."**

## 3. 라이브 프로브 증거 (2026-09-04)

실제 Z.AI 계정의 zai 클래스 API 키 + ZCode 소스 헤더를 그대로 붙여 프로브함.

| # | 요청 | 결과 | 해석 |
|---|---|---|---|
| E1 | `GET https://api.z.ai/api/anthropic/v1/models` + `Authorization: Bearer <key>` | HTTP 200, `application/json`, body `{"data":[{"created_at":"...","display_name":"GLM-4.5","id":"glm-4.5","type":"model"},...]}` | OpenAI 형태 envelope. 약 15개 모델 (glm-4.5..glm-5.x). 계정 실측 카탈로그 조회 가능 |
| E2 | `GET https://api.z.ai/api/anthropic/models` (`/v1` 없음) | HTTP 200이나 body가 `{"code":500,"msg":"404 NOT_FOUND","success":false}` | **canonical 경로는 `/v1/models`뿐**. HTTP 상태만으로 성공 판정하면 안 되고 body의 `data` 배열 존재를 검증해야 함 |
| E3 | 자격증명 적합성 | glm-zcode OAuth 플로우가 프로비저닝하는 키가 정확히 이 클래스(`{id}.{secret}` Z.AI API 키) | 동일 엔드포인트가 프로비저닝 자격증명을 그대로 수용. 추가 인증 플로우 불필요 |

## 4. 의사결정 포인트 (Evidence-based)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| P1 | 라이브 엔드포인트 | `GET https://api.z.ai/api/anthropic/v1/models` + `Authorization: Bearer <provisioned key>` | E1 (200 + OpenAI envelope). E2로 `/v1` 생략 경로는 body-레벨 404임이 확인되어 경로 고정. 키는 oauth credential의 `.access`에서 취함 (pi-ai `OAuthCredential { type:"oauth"; access; refresh; expires }`, 이 provider에서는 모델 API 키가 `.access`) |
| P2 | 폴백 체인 | 라이브 → models.dev → stored → 정적 | 라이브 성공 시 즉시 publish. 실패/미로그인 시 PR #2의 models.dev 경로를 그대로 타고, 그것도 실패하면 stored 매핑, 최후로 정적 fallback. 하위 단계의 의미론(PR #2 P6: throw 금지, undefined 반환 시 기존 유지)은 변경하지 않음 |
| P3 | 원격 ID 새니타이즈 | 제어문자 포함 ID 드롭, 빈 문자열 드롭, 길이 >200 드롭. 응답 body 상한 1MB | 라이브 응답은 원격 제어 데이터라 그대로 신뢰 불가. E1의 정상 응답 형태(`data[].id` 문자열)와 무관한 malformed 항목을 저장/publish 전에 제거. 1MB 상한은 비정상 대형 응답으로 인한 메모리/파싱 폭주 방지 |
| P4 | 캐시 전략 | force + TTL 기반. 자격증명 지문(fingerprint)을 타입상 저장 불가 | pi-ai `RefreshModelsContext`는 `{ credential?; stored?; publish(); allowNetwork; force? }`뿐이고 `ModelsStoreEntry`는 `{ models; lastModified?; checkedAt?; etag? }`로 지문 필드가 없음. 따라서 "어느 계정 키로 가져온 카탈로그인지"를 저장소에서 구분할 수 없다. 결과: **재로그인(키 교체) 후에도 TTL(≤24h)이 남은 부실 캐시가 최대 TTL 기간 동안 반환될 수 있음**을 한계로 명시. 사용자가 즉시 갱신하려면 force 경로(`omo update --models`)를 쓴다 |

## 5. 비-목표 (Non-goals)

- `oauth.ts` 로그인 플로우, TTL(PR #5의 10년 고정), 헤더 변경 없음. 이 PR은 `refreshModels`의 소스 우선순위만 건드린다
- models.dev 경로 제거 아님. 폴백 체인의 2단계로 그대로 유지 (P2)
- 정적 fallback 모델 변경 없음

## 6. 검증 계획 요약

| 기준 | 시나리오 |
|---|---|
| C001 (happy) | vitest: 라이브 200 응답(E1 형태 fixture) 시 계정 카탈로그가 publish되고 models.dev fetch가 호출되지 않음 |
| C002 (edge) | vitest: 라이브 실패(네트워크/401/E2형 body-404/1MB 초과/새니타이즈 대상 ID) 시 models.dev → stored → 정적 순으로 fallback |
| C003 (regression) | 기존 테스트 무수정 통과 + `bunx tsc --noEmit` 클린 (worktree는 node_modules symlink, bun install 금지) |

---

*이 문서는 mass-ulw DAG 설계의 입력이다. 각 구현 노드는 위 결정값을 그대로 따른다.*
