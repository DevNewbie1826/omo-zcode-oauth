# PR #2 이상 상태 정의 — 동적 모델 카탈로그

작성일: 2026-08-29 · 근거: 병렬 explore 2개 (refreshModels 의미론, models.dev 스키마) + 사용자 확정 설계

## 현재 문제 상황

PR #1로 병합된 확장은 모델 목록을 하드코딩(`glm-5.2` 1개). 새 GLM 모델 출시 시 확장 코드 수정+재배포가 필요. models.dev `zai-coding-plan`에 이미 7개 지원 모델이 있고, omo 빌트인 `zai` provider가 동일 목록을 번들로 보유(pi-ai `dist/providers/data/zai.json`)함이 확인됨.

## 이상 상태

`glm-zcode` provider가 models.dev 카탈로그를 동적으로 따라가고, 사용자는 `glm-zcode/glm-5.3` 등 카탈로그 내 모든 모델을 선택 가능. 오프라인/장애 시에도 모델 0개 상태가 되지 않음.

## 의사결정 (근거 기반)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| P1 | 카탈로그 소스 | models.dev `api.json`의 `zai-coding-plan` | live fetch 확인; senpi 자체 카탈로그 생성 소스와 동일 |
| P2 | 전송 flavor 유지 | `anthropic-messages` @ `api.z.ai/api/anthropic` (메타데이터만 가져옴) | ZCode 프로비저닝 키는 이 엔드포인트로 검증됨 (PR #295/gajae live traffic). models.dev의 paas/v4 openai flavor를 따르지 않음 |
| P3 | modalities 필터 | pi `input`은 `"text"\|"image"\|"video"`만 — `"pdf"` 드롭 (glm-5.3-flash) | ProviderModelConfig 타입 (types.d.ts) |
| P4 | cost | 전부 0 | 구독제; models.dev zai-coding-plan도 전부 0 |
| P5 | 정적 fallback | `glm-5.3` 단 1개 (5.2에서 변경) | 사용자 결정: 세션 복원/첫 refresh 전 0-모델 상태 방지 |
| P6 | 실패 의미론 | throw 금지. 실패/오프라인+stored 없음 → `undefined` 반환(정적 유지). 오프라인+stored → stored 매핑 반환. 성공 → publish+persist | pi-ai models.js:134-153 (throw는 조용히 수집되지만 dynamic 미갱신), provider-composer.js:272-286 (undefined 반환 시 기존 유지) |
| P7 | 자체 TTL | 24h, `stored.checkedAt` 기준 (force면 무시) | 커스텀 provider에 내장 TTL 없음 (remote-catalog-provider.js:14는 4h이나 빌트인 전용); api.json ~400KB를 매 startup마다 받지 않기 위함 |
| P8 | persist 형태 | 완전한 `Model<Api>` 배열 + `provider: "glm-zcode"` 필드 필수 | 복원 필터가 `model.provider === id`로 필터 (models.js:168-183) |

## 런타임 흐름 (E1 확인)

- 로그인 전: phase 2(네트워크)는 자격증명 필요 → 정적 fallback(glm-5.3)만 표시
- `/login glm-zcode` 직후: provider-scoped refresh가 트리거되어(interactive-mode.js:6372) 전체 카탈로그 fetch → 7개 모델 표시
- 이후 startup/모델 선택기 열기/`omo update --models` 시 TTL 내 stored 복원, TTL 경과 시 재fetch

## 검증 계획

- C001: vitest 매핑 테스트 + 실제 `omo --list-models glm-zcode`에 동적 모델 표시
- C002: 오프라인/malformed/fetch실패/publish실패 경로 vitest
- C003: 기존 13개 OAuth 테스트 무수정 통과 + fallback이 glm-5.3 + `omo auth check --provider zai` 무영향
