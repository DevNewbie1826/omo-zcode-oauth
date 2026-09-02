# omo-zcode-oauth

[omo](https://github.com/code-yeongyu/omo) CLI용 비공식 ZCode OAuth 확장입니다. GLM ZCode 로그인을 `glm-zcode` provider로 등록해 줍니다.

> **경고**
>
> 이 프로젝트는 ZCode 데스크톱 앱의 로그인 플로우를 재현한 **비공식** 구현입니다.
>
> - Z.AI / ZCode의 공식 OAuth 클라이언트가 아닙니다.
> - 서비스 이용약관(ToS) 위반으로 간주될 수 있습니다.
> - PKCE가 없는 플로우를 그대로 재현하므로 보안상 취약점이 있습니다.
> - Z.AI 측 변경에 따라 언제든 예고 없이 동작이 중단될 수 있습니다.
>
> 사용에 따른 모든 책임은 사용자 본인에게 있습니다.

## 사전 준비

- [omo CLI](https://github.com/code-yeongyu/omo)가 설치되어 있어야 합니다.

## 설치

GitHub에서 바로 설치:

```bash
omo install git:github.com/DevNewbie1826/omo-zcode-oauth
```

로컬 경로에서 설치:

```bash
omo install ./local/path
```

## 사용법

1. omo를 실행하고 `/login glm-zcode`를 입력합니다.
2. 브라우저에서 Z.AI 로그인 페이지가 열립니다. 로그인을 완료합니다.
3. 로그인 결과는 폴링으로 자동 감지되며, 이어서 토큰 교환과 API 키 프로비저닝이 진행됩니다.
4. 끝. 터미널에 코드를 붙여넣을 필요 없이 로그인이 완료됩니다.

프로비저닝된 Z.AI API 키는 만료 없이 장기 유효하게 사용됩니다. PR #5 이전 버전에서 업그레이드한 경우에는 `/login glm-zcode`로 1회 재로그인해야 합니다.

## 콜백 URL 가져오기 (폴백)

기본 device flow 엔드포인트에 연결할 수 없으면 기존 `zcode://` URL 붙여넣기 방식으로 자동 전환됩니다. 이 폴백에서 리다이렉트 주소가 `https://`가 아니라 `zcode://` 커스텀 프로토콜이라, **ZCode 데스크톱 앱이 설치되어 있으면 OS가 그 주소를 앱으로 넘겨버립니다.** 그래서 주소창에 URL이 남지 않고 ZCode 앱만 열리는 현상이 생깁니다. 아래 방법으로 URL을 가로채 복사하세요.

> **가장 중요**
>
> - 브라우저가 띄우는 **"ZCode을(를) 여시겠습니까?" 다이얼로그는 반드시 `취소`** 하세요.
> - 앱을 열어버리면 일회용 authorization code가 **ZCode 앱에서 소모**되어, 같은 URL을 붙여넣어도 교환에 실패합니다. 그때는 `/login glm-zcode`부터 다시 시작해야 합니다.
> - 이 URL에는 일회용 인증 정보가 들어 있습니다. 절대 공유하지 마세요 (PKCE가 없는 플로우라 코드 유출 시 계정 접근에 악용될 수 있습니다).

### 방법 A — Chrome / Edge (권장)

1. `/login glm-zcode` 실행 후 브라우저가 열리면, **로그인하기 전에** 개발자도구를 엽니다 (`F12` 또는 macOS `⌥⌘I`).
2. **Network(네트워크) 탭**으로 이동한 뒤 **`Preserve log`(로그 유지)** 를 체크합니다. 리다이렉트로 기록이 지워지는 것을 막아 줍니다.
3. Z.AI 로그인을 완료합니다.
4. "ZCode을(를) 여시겠습니까?" 다이얼로그가 뜨면 **취소**를 누릅니다.
5. Network 탭 목록에서 `zcode://oauth/callback?...` 항목을 찾습니다. 보통 실패 상태(`ERR_UNKNOWN_URL_SCHEME`)로 표시됩니다.
6. 그 항목을 우클릭 → **Copy → Copy link address** (또는 항목 클릭 후 Headers의 Request URL 복사) 로 전체 URL을 복사합니다.
7. 터미널의 omo 프롬프트에 붙여넣습니다.

### 방법 B — Firefox (가장 간단)

1. Firefox로 로그인 플로우를 진행합니다.
2. 앱 열기 다이얼로그를 **취소**합니다.
3. **주소창에 `zcode://oauth/callback?code=...&state=...` 전체 URL이 그대로 남아 있습니다.** 그대로 복사해 붙여넣으면 됩니다.

### 방법 C — ZCode 앱이 설치되지 않은 환경

ZCode 데스크톱 앱이 없는 브라우저 프로필/기기라면 프로토콜 핸들러가 없어서, 리다이렉트 시 "주소를 이해할 수 없습니다" 류의 오류 페이지가 뜨고 **주소창에 전체 URL이 그대로 남습니다.** 가장 확실한 방법입니다.

> 참고: 시크릿 모드는 도움이 되지 않습니다. 프로토콜 핸들러 등록은 브라우저 프로필이 아니라 **OS 레벨**이기 때문입니다.

### 방법 D — Safari

Safari는 기본적으로 개발자 도구가 꺼져 있습니다. `설정 → 고급 → 메뉴 막대에서 개발자용 메뉴 보기`를 켠 뒤 웹 인스펙터의 네트워크 탭에서 방법 A와 동일하게 진행하거나, 더 간단한 방법 B(Firefox)를 사용하세요.

### 붙여넣을 형태

```
zcode://oauth/callback?code=<authorization-code>&state=<state>
```

- **전체 URL**이 필요합니다. `code` 값만 붙여넣으면 거부됩니다.
- `state` 값은 로그인 시도마다 새로 생성되므로, **지금 진행 중인 시도의 URL**이어야 합니다.

### 문제 해결

| 메시지 | 원인과 해결 |
|---|---|
| `GLM ZCode requires the complete zcode:// callback URL` | code 값만 붙여넣었거나 URL 형식이 아닙니다. 전체 URL을 복사하세요. |
| `GLM ZCode callback URL is invalid` | 프로토콜·호스트·경로가 다르거나(`zcode://oauth/callback`이어야 함) 포트·해시 등 불필요한 요소가 붙었습니다. |
| `GLM ZCode callback URL must contain exactly one non-empty code and state` | URL이 잘렸습니다. 주소 전체를 다시 복사하세요. |
| `GLM ZCode callback state did not match` | 이전 로그인 시도의 URL입니다. `/login glm-zcode`를 다시 실행해 새 URL을 받으세요. |
| broker 요청 실패 (`400` 등) | 앱이 code를 이미 소모했거나 만료됐습니다. 앱 열기 다이얼로그를 취소하고 처음부터 다시 시도하세요. |
| 로그인은 됐는데 호출 시 `1113 Insufficient balance or no resource package` | 확장 문제가 아니라 **Z.AI 계정에 활성 리소스 패키지/잔액이 없는 것**입니다. Coding Plan이 활성화된 계정으로 다시 로그인하거나 Z.AI 대시보드에서 충전하세요. |

## 모델

로그인 후 Z.AI Coding Plan의 전체 모델 목록을 사용할 수 있습니다 (`glm-zcode/glm-5.3`, `glm-zcode/glm-5.3-flash`, `glm-zcode/glm-5.2`, `glm-zcode/glm-4.7` 등). 목록은 models.dev 카탈로그(`zai-coding-plan`)에서 동적으로 가져오므로 새 모델이 나오면 자동으로 반영됩니다.

## 모델 카탈로그

모델 목록은 하드코딩되어 있지 않고 다음과 같이 관리됩니다.

- **동적 조회**: `/login glm-zcode` 직후 첫 전체 갱신이 실행되고, 이후 models.dev의 `zai-coding-plan` 카탈로그에서 최신 목록을 가져옵니다.
- **로컬 캐시**: 가져온 목록은 `models-store.json`에 24시간 TTL로 캐시됩니다. 오프라인 상태로 재시작해도 마지막으로 가져온 목록을 그대로 사용합니다.
- **정적 폴백**: 카탈로그를 아직 가져오기 전(설치 직후 로그인 전 등)이거나 카탈로그에 연결할 수 없을 때는 정적 `glm-5.3` 폴백을 노출해 모델이 0개가 되는 일이 없습니다.
- **강제 갱신**: `omo update --models`를 실행하면 TTL과 무관하게 카탈로그를 다시 가져옵니다.

## 동작 원리

ZCode 앱의 로그인 플로우를 재현합니다. 최종적으로 Z.AI 대시보드 API 키(`{id}.{secret}`)를 발급받아 `https://api.z.ai/api/anthropic` 엔드포인트에 Bearer 인증으로 사용합니다.

1. **Device flow**: CLI init으로 브라우저 로그인 URL과 폴링 정보를 받고, 로그인 완료 후 authorization code를 자동으로 가져옵니다.
2. **폴백**: device flow 엔드포인트에 연결할 수 없으면 `chat.z.ai/api/oauth/authorize`의 최종 `zcode://` URL을 사용자가 직접 붙여넣고, `zcode.z.ai/api/v1/oauth/token`에서 upstream Z.AI 토큰으로 교환합니다.
3. **Provision**: Z.AI business 로그인 후 대시보드 API 키를 조회하거나 생성해 최종 키를 얻습니다.

## 기존 zai provider와의 공존

이 확장은 기존에 설정된 `zai` provider를 건드리지 않습니다. `glm-zcode`는 별도 provider로 등록되므로 둘을 함께 사용할 수 있습니다.

## 제거

```bash
omo remove git:github.com/DevNewbie1826/omo-zcode-oauth
```

## 기술 문서

구현의 근거가 된 조사 보고서와 상세 플로우는 [`docs/research/`](docs/research/)에서 확인할 수 있습니다.

## 라이선스

MIT
