# PR #7 이상 상태 정의 — 하이브리드 라이브 카탈로그 (계정 실측 우선)

작성일: 2026-09-04 · 근거: 실계정 라이브 프로브 (2026-09-04) + pi-ai 타입 사실 + PR #2/P5 선행 설계

---

## 1. 현재 문제 상황

| 항목 | 상태 | 근거 |
|---|---|---|
| 카탈로그 소스 | `refreshModels`가 models.dev `zai-coding-plan` 스냅샷만 조회 | PR #2 결정 P1 |
| 신모델 반영 지연 | Z.AI가 신모델을 출시해도 models.dev 갱신(3rd-party 수작업/크롤) 전까지 확장 사용자에게 표시되지 않음 | models.dev 갱신 주체가 Z.AI가 아님 |
| 계정 실권한과 불일치 | models.dev 목록은 전체 플랜 기준 스냅샷이라, 이 계정이 실제로 쓸 수 있는 모델 집합과 어긋날 수 있음 | 카탈로그가 계정 컨텍스트 없이 정적 제공 |
| 사용 가능한 대안 미활용 | glm-zcode OAuth가 프로비저닝하는 키("{id}.{secret}" Z.AI API 키)로 계정 실측 모델 목록을 직접 조회 가능함이 확인됐으나 코드에 미반영 | 라이브 프로브 2026-09-04 (아래 §3) |

## 2. 이상 상태

**"glm-zcode 로그인 후 refreshModels는 프로비저닝된 Z.AI API 키로 계정 실측 카탈로그를 우선 조회하고, 실패 시 기존 models.dev 경로와 저장/정적 폴백을 그대로 유지한다."**

### 구체적 완료 조건

1. 자격증명이 있고 네트워크가 허용되면 `GET https://api.z.ai/api/anthropic/v1/models`에 `Authorization: Bearer <프로비저닝 키>`로 계정 실측 목록을 먼저 요청한다.
2. 라이브 조회가 실패(네트워크, 비-200, 스키마 불일치)하면 기존 models.dev `zai-coding-plan` 경로로 내려가고, 그마저 실패하면 stored, 최후로 정적 폴백 순으로 동작한다. 어느 단계의 실패도 throw하지 않는다.
3. 원격 모델 ID는 새니타이즈 후에만 카탈로그에 들어간다.
4. oauth.ts 로그인 플로우, TTL(PR #5의 10년), 헤더는 변경하지 않는다. models.dev 소스는 제거하지 않고 폴백으로 유지한다.

## 3. 라이브 프로브 증거 (2026-09-04, 실제 Z.AI 계정 키, ZCode 소스 헤더 첨부)

| 프로브 | 결과 | 해석 |
|---|---|---|
| `GET https://api.z.ai/api/anthropic/v1/models` + `Authorization: Bearer <key>` | HTTP 200, `application/json`, body `{"data":[{"created_at":"...","display_name":"GLM-4.5","id":"glm-4.5","type":"model"},...]}` (OpenAI형 envelope, glm-4.5~glm-5.x 약 15개) | 정규 엔드포인트 존재. 프로비저닝 키 그대로 인증됨 |
| `GET https://api.z.ai/api/anthropic/models` (`/v1` 없음) | HTTP 200이지만 body가 `{"code":500,"msg":"404 NOT_FOUND","success":false}` | 정규 경로는 `/v1/models` 뿐. HTTP 200만으로 성공 판정 불가, body 스키마 검증 필수 |
| 키 클래스 | glm-zcode OAuth 플로우가 프로비저닝하는 키가 정확히 이 zai 클래스("{id}.{secret}" 형식) | 동일 엔드포인트가 프로비저닝된 자격증명을 그대로 서빙 |

## 4. 의사결정 포인트 (근거 기반)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| P1 | 라이브 엔드포인트 | `GET https://api.z.ai/api/anthropic/v1/models`, Bearer 인증 | 프로브 200 + OpenAI형 envelope 확인. `/v1` 없는 경로는 200 래핑된 404 바디를 돌려주므로 `/v1/models`만 정규 경로 |
| P2 | 폴백 체인 | 라이브 -> models.dev -> stored -> 정적. 각 단계 실패 시 다음 단계, throw 금지 | PR #2 P6의 실패 의미론(pi-ai models.js:134-153, provider-composer.js:272-286)을 그대로 앞단에 한 단계 추가. models.dev 경로와 저장/정적 폴백은 기존 코드 유지 |
| P3 | 원격 ID 새니타이즈 | 제어문자 포함, 빈 문자열, 길이 > 200인 ID는 드롭. 응답 바디 상한 1MB | 원격이 공급하는 문자열이 그대로 모델 ID/디스플레이명이 되므로 경계 검증은 이 지점이 유일. body가 200 래핑 에러일 수 있어(프로브) envelope 스키마 검증과 함께 수행 |
| P4 | 캐시 전략 | 라이브 성공분도 `publish`+persist로 stored에 기록. 자격증명 지문(fingerprint)은 `ModelsStoreEntry` 타입(`{models; lastModified?; checkedAt?; etag?}`)에 저장 불가하므로, 계정/키 변경 감지는 불가. 대신 PR #2 P7의 자체 TTL(24h, `stored.checkedAt` 기준)과 `force` 플래그(`RefreshModelsContext.force`)로 신선도 관리 | pi-ai 타입 사실: `RefreshModelsContext`는 `credential?`, `stored?`, `publish()`, `allowNetwork`, `force?`만 제공. `Credential`은 `ApiKeyCredential{type:"api_key"}` 또는 `OAuthCredential{type:"oauth"; access; refresh; expires}`의 태그드 유니언이며 이 provider의 모델 API 키는 oauth credential의 `.access` |

### P4 부연: 부실(stale) 캐시 한계

`ModelsStoreEntry`에 키 지문을 넣을 수 없으므로, 다른 계정으로 재로그인해도 stored는 이전 계정의 라이브 카탈로그일 수 있다. 이 경우 재로그인 후 최대 TTL(24h) 동안 부실 캐시가 서빙된다. `force` refresh(`/login` 직후 provider-scoped refresh, `omo update --models`)가 이 창을 닫는 유일한 경로이며, PR #2에서 확인된 대로 `/login glm-zcode` 직후 force refresh가 트리거되므로(interactive-mode.js:6372) 실질 노출은 짧다. 이 한계는 타입 제약에서 오는 것이므로 문서에 명시하고 별도 우회를 만들지 않는다.

## 5. 비-목표

- oauth.ts 로그인 플로우, TTL(10년), 요청 헤더 변경 없음.
- models.dev 카탈로그 소스 제거 아님. 폴백 체인의 두 번째 단계로 그대로 유지.
- 신규 인증/계정 관리 기능(키 지문 저장, 계정 전환 감지) 없음. P4의 한계를 수용한다.

## 6. 검증 계획 요약

| 기준 | 시나리오 |
|---|---|
| C001 (happy) | 라이브 200 응답이 카탈로그에 반영되고 stored에 persist됨 |
| C002 (fallback) | 라이브 실패(비-200, 200 래핑 에러 바디, 네트워크 오류) 각각에서 models.dev -> stored -> 정적 순으로 내려가고 throw 없음 |
| C003 (sanitize) | 제어문자/빈/길이>200 ID 드롭 + 1MB 초과 응답 거부 |
| C004 (regression) | 기존 테스트 무수정 통과 + `bunx tsc --noEmit` 클린 |

---

*이 문서는 mass-ulw DAG 설계의 입력이다. 각 구현 노드는 위 결정값을 그대로 따른다.*
