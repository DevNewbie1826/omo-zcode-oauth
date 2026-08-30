# PR #5 이상 상태 정의 — 장기유효 API 키 TTL (55분 재프로비전 제거)

작성일: 2026-08-30 · 근거: 병렬 explore 2개 + 실데이터 auth.json 분석 + senpi auth 머신 코드 검토

---

## 1. 현재 문제 상황 (Current State)

| 항목 | 상태 | 근거 |
|---|---|---|
| 증상 | 로그인 ~1-2시간 후 `OAuth refresh failed for glm-zcode: ... re-provisioning the Z.AI API key failed` | 사용자 보고 2026-08-30 |
| upstream 토큰 수명 | **정확히 1시간** (JWT exp-iat=3600s) | `~/.omo/agent/auth.json` 실측: iat 2026-08-29T14:16:39Z → exp 15:16:39Z |
| 저장된 expires | 로그인 + 55분 (`REPROVISION_INTERVAL_MS`) | `extensions/glm-zcode/oauth.ts:10,160` |
| refresh 토큰 | upstream 토큰을 그대로 저장, **절대 로테이션 안 됨** | `oauth.ts:159` (`refresh: upstreamToken`) |
| 실패 경로 | senpi `expiresSoon`(만료 5분 전) → `refreshToken()` → `provision(refresh)` → z/login이 죽은 토큰 거부 → catch가 원인 삼키고 re-login 에러 | `senpi-src/packages/ai/src/auth/resolve.ts:155,171-174`; `oauth.ts:206-213` |
| 필연성 | 첫 refresh(+55분)는 upstream 만료 5분 전이라 간신히 성공 가능, 두 번째(+1시50분)는 **항상 실패**. 하루 뒤 실행 시 100% 재현 | 타임라인 분석 |
| 55분 근거 | **PR #295 어디에도 rationale 없음** (diff/리서치/커밋 메시지 전부 무언) | `reference/pr295.diff:79,191`; `zcode-oauth-extension-research.md:48` |
| 원본(gajae) 설계 | 10년 고정 + 명시적 주석 "pin expiry far out so AuthStorage never force-refreshes" | `reference/gajae-glm-zcode.ts:36-37,318` |

## 2. 이상 상태 (Ideal End State)

**"한 번 `/login glm-zcode` 하면 프로비저닝된 Z.AI API 키가 대시보드에서 폐기되지 않는 한 만료 없이 계속 동작한다. 55분 주기 재프로비전과 그로 인한 재로그인 강제는 사라진다."**

### 구체적 완료 조건

1. `expires`가 장기 TTL(10년, gajae `GLM_ZCODE_API_KEY_TTL_MS`와 동일)로 설정되어 senpi가 refresh를 사실상 트리거하지 않음
2. `refreshToken` 경로는 유지하되 "upstream 토큰 만료 시 수동 재로그인" 전용으로 문서화 (gajae 원본과 동일한 의미론)
3. refresh 실패 에러가 원인 상세를 포함 (gajae의 `redactSecrets` 방식 복원 — 현재 포트는 catch가 원인을 삼킴, `oauth.ts:209-212`)
4. 기존 테스트 전부 통과 + TTL assertion이 새 값을 검증
5. README/리서치 문서의 55분 설명이 새 동작과 일치

## 3. 의사결정 포인트 (Evidence-based)

| # | 결정 | 선택지 | 근거 | 결정값 |
|---|---|---|---|---|
| R1 | **expires 전략** | 55분 재프로비전 (현행) vs 10년 고정 (gajae) | upstream 토큰 1시간 수명으로 55분 재프로비전은 구조적 불가(두 번째 refresh 필연 실패). 프로비저닝된 API 키는 대시보드 키와 동일하게 만료 없음. senpi는 10년 expires를 안전하게 처리 (`resolve.ts:155` 비교만, `Number.isFinite` 검증만, OpenRouter가 `MAX_SAFE_INTEGER` 선례). PR #295에 55분 근거 무언. | **10년 고정** — gajae 원본 설계 복원 |
| R2 | **refreshToken 유지 여부** | 제거 vs 유지 | senpi `ProviderConfig.oauth` 인터페이스가 `refreshToken` 필수 요구. expires가 멀면 호출되지 않지만, 명시적 refresh 요청(예: `minOAuthValidityMs` 지정 호출자)이나 미래 senpi 변경 대비 필요. | **유지** — upstream 만료 시 re-login 에러로 명확히 실패 |
| R3 | **refresh 실패 에러 상세** | 현행(원인 삼킴) vs gajae `redactSecrets` 복원 | 현재 포트는 catch가 원인 에러를 버려 사용자가 401인지 네트워크인지 알 수 없음 (`oauth.ts:209-212`). gajae는 `redactSecrets(String(error))`로 상태/메시지를 포함하되 토큰은 마스킹 (`gajae-glm-zcode.ts:87-92,428-431`). 리서치 문서도 이 갭을 지적 (`zcode-oauth-extension-research.md:47`). | **redactSecrets 복원** — 에러에 redacted 상세 포함 |
| R4 | **주기적 리프레시 도입** | 10년 + 주기적 재프로비전 vs 10년만 | 갱신 가능한 자격증명이 존재하지 않음(upstream 1시간, 로테이션 없음). 재프로비전은 키 로테이션이 아니라 같은 키 재조회라 "신선함" 효과 없음. 비공식 플로우에 주기적 biz API 호출은 탐지 리스크만 증가. | **도입 안 함** — 10년 고정만 |
| R5 | **기존 자격 마이그레이션** | 코드에서 강제 vs 사용자 재로그인 안내 | 이미 저장된 자격의 `expires`는 과거라 코드 수정 후에도 첫 실행 시 refresh를 탐. 코드에서 구 자격을 감지해 자동 수정하는 것은 auth.json 스키마 침범. | **재로그인 안내** — README에 "PR #5 이후 1회 `/login glm-zcode`" 명시 |

## 4. 위험 및 완화

| 위험 | 영향 | 완화 |
|---|---|---|
| API 키가 실제로는 만료됨 | 10년 후 또는 Z.AI 정책 변경 시 인증 실패 | refreshToken 경로 유지(R2) + 에러 메시지에 재로그인 안내. 대시보드 키와 동일한 수명 모델이라 실질 리스크 낮음 |
| upstream 토큰 만료를 조용히 놓침 | 키 폐기 시 다음 사용에서야 실패 발견 | R3의 상세 에러로 원인 즉시 파악 가능. gajae 원본도 동일 trade-off를 문서화하고 채택 |
| senpi가 미래에 expires 상한 검증 추가 | 10년 값 거부 가능성 | OpenRouter `MAX_SAFE_INTEGER` 선례가 있어 상한 도입 시 그쪽도 깨짐 — senpi가 먼저 대응할 것. 발생 시 TTL 조정으로 대응 |
| 기존 사용자 혼란 | PR 후에도 같은 에러 1회 발생 | README + PR 본문에 "1회 재로그인 필요" 명시 (R5) |

## 5. 검증 계획 요약

| 기준 | 시나리오 | 증거 |
|---|---|---|
| C001 (happy) | vitest: 로그인 플로우의 `credentials.expires`가 `now + 10년 ± 허용오차` 범위인지 assertion (기존 55분 assertion 교체) | `.omo/evidence/ulw/pr5-api-key-ttl/.../C001-vitest.txt` |
| C002 (edge) | vitest: refresh 성공 시에도 동일 10년 TTL 적용 + refresh 실패 에러에 redacted 상세 포함 (`[redacted]` 마스킹 검증) | `.omo/evidence/ulw/pr5-api-key-ttl/.../C002-vitest.txt` |
| C003 (regression) | 기존 29개 테스트 무수정 통과 + `npx tsc --noEmit` 클린 | `.omo/evidence/ulw/pr5-api-key-ttl/.../C003-*.txt` |

---

*이 문서는 mass-ulw DAG 설계의 입력이다. 각 구현 노드는 위 결정값을 그대로 따른다.*
