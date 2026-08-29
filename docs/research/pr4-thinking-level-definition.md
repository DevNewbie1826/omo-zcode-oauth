# PR #4 이상 상태 정의 — thinkingLevelMap (Z.AI 1210 수정)

작성일: 2026-08-29 · 근거: E1 탐색(pi-ai wire) + 외부 이슈 3건 + 실제 Z.AI curl 매트릭스(실계정 키)

## 문제 (RED 증거, 실제 엔드포인트)

사용자 기본 thinking level(medium)에서 `omo` → glm-zcode/glm-5.3 호출 시 400 code 1210 "This model always engages in thinking and cannot be disabled; please use low, high, or max".

원인 체인: 확장 모델에 `thinkingLevelMap` 부재 → pi anthropic-messages flavor의 기본 매핑이 `medium`을 `output_config.effort: "medium"`으로 그대로 전송 (anthropic-messages.js:1352 mapThinkingLevelToEffort) → Z.AI는 low/high/max만 수용 → 1210.

curl 매트릭스 (api.z.ai/api/anthropic, 실제 프로비저닝 키, 2026-08-29):
| 페이로드 | 결과 |
|---|---|
| glm-5.3 `thinking:{type:disabled}` | 400 1210 (RED) |
| glm-5.3 `output_config.effort:"medium"` | 400 1210 (사용자 오류 정확히 재현, RED) |
| glm-5.3 effort low / max / thinking-삭제+effort-low | 429 1113 (잔액) — **파라미터 검증 통과 (GREEN)** |
| glm-5.2 effort low / high | 429 — 5.2도 low 수용 (models.dev 명세 high/max보다 관대) |
| glm-4.7 thinking:disabled / effort medium | 429 — 토글 모델은 off 수용, medium도 통과 |

## 의사결정

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| Q1 | 매핑 | minimal/low/medium→"low", high→"high", xhigh/max→"max" | Z.AI 수용 3단계; medium은 다운클램프 (번들 zai.json 컨벤션 동일) |
| Q2 | off 처리 | 기본값 활용: `compat.supportsDisabledThinking` 미설정 시 `cannotDisableThinking`이 true → thinking 삭제 + effort low (matrix e에서 검증 통과). effort형(5.3/5.2 계열)은 명시적으로 `supportsDisabledThinking: false` 기록 | anthropic-messages.js:1322-1337 |
| Q3 | 토글 모델(4.7, 5-turbo) | 동일 map 부여하되 compat 플래그 미설정 (실제 off 유지 — f에서 검증) | models.dev reasoning_options.type==="toggle" |
| Q4 | 동적 매핑 규칙 | reasoning_options.type==="effort" → map+flag, "toggle" → map만, 부재 → map+flag(보수적: 신규 모델은 always-think 추세) | api.json에 reasoning_options 존재 확인 |
| Q5 | persist 왕복 | catalogToPersistedModels/storedToConfig가 thinkingLevelMap+compat를 왕복 | 오프라인 복원 시 map 손실 방지 |
| Q6 | 429 잔액 이슈 | 본 PR 범위 밖 — 사용자 계정/리소스 패키지 문제로 사용자에게 보고 | 매트릭스에서 관찰 |

## 이상 상태

`--thinking medium` (사용자 기본값)으로 glm-zcode 호출 시 1210 미발생. 모든 카탈로그 모델이 레벨 무관하게 검증 통과.

## 검증 계획

- C001 (happy): vitest — 정적 fallback + 동적 매핑의 thinkingLevelMap/compat 값 assertion; 실제 surface: `omo -p hi --model glm-zcode/glm-5.3 --thinking medium`이 1210이 아님 (RED: 사전 1210 재현됨)
- C002 (edge): 토글/effort/unknown 3종 reasoning_options 매핑 + persist 왕복 왕복 테스트
- C003 (regression): 기존 24 테스트 무수정 통과, OAuth 미변경
