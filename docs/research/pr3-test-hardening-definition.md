# PR #3 이상 상태 정의 — 테스트 강화 (TEST-ONLY)

작성일: 2026-08-29 · 근거: UltraBrain PR #2 리뷰 NOTE 2건 + explore 검증 (st_01a04d6a)

## 현재 문제 상황

PR #2 머지 후 테스트 22개 통과 중이나, UltraBrain 리뷰가 2개 커버리지 약점을 지적:
1. publish assertion이 `.every()` 사용 — 빈 배열에서 공허하게 통과 (test/glm-zcode.test.ts:416-424, 리뷰 인용 439-447은 부정확)
2. publish-failure 테스트 부재 + 스키마 변형(name 누락, non-record 엔트리) fixture 미고정 (fixture는 345-370)

## 핵심 발견 (explore 검증)

**publish 실패 시 실제 동작은 "stored/fallback 반환"** — `await context.publish()`가 try 내부(index.ts:54)에 있어 reject 시 catch(61-64)로 이동, fresh list는 반환되지 않음. 리뷰 노트의 "fresh list 반환" 기대치와 발산.

## 의사결정

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| T1 | publish-failure 테스트가 pin하는 동작 | **실제 동작**: publish reject → throw 없음, stored 있으면 stored 매핑 반환, 없으면 undefined | TEST-ONLY scope; 테스트는 실제 동작을 pin. "fresh list 반환"으로 바꾸려면 구현 변경 필요 → PR 본문에 명시해 리뷰어가 판단 |
| T2 | .every() 약점 | persisted 배열의 정확한 길이 + ID 목록 + 각 엔트리 provider/api/baseUrl assertion으로 교체 | 공허 통과 방지 |
| T3 | 스키마 변형 fixture | name 누락 → id로 fallback, non-record 엔트리 skip, 기존 broken-context skip 유지 | models.ts:43-62 실제 동작 고정 |

## 이상 상태

테스트 25개(기존 22 + 신규 3): publish-failure, missing-name fallback, non-record skip. 구현 코드(`extensions/`) 변경 없음. tsc + vitest 그린.

## 검증 계획

- C001: 신규 3 테스트가 실제 동작을 pin하며 통과 (vitest)
- C002: mutation probe — publish-reject 시 stored-fallback 대신 fresh list를 반환하도록 구현을 임시 변형하면 신규 테스트가 실패함을 확인 후 되돌림 (테스트가 실제 회귀를 잡는지 증명)
- C003: 기존 22 테스트 무수정 통과, extensions/ diff 없음
