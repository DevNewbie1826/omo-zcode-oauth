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
3. 로그인 후 브라우저가 `zcode://` 주소로 리다이렉트됩니다. 주소창의 전체 URL을 복사해 터미널에 붙여넣습니다.
4. 끝. 자동으로 토큰 교환과 API 키 프로비저닝이 진행되고 로그인이 완료됩니다.

## 모델

로그인 후 다음 모델을 사용할 수 있습니다:

- `glm-zcode/glm-5.2`

## 동작 원리

ZCode 앱의 로그인 플로우를 재현합니다. 최종적으로 Z.AI 대시보드 API 키(`{id}.{secret}`)를 발급받아 `https://api.z.ai/api/anthropic` 엔드포인트에 Bearer 인증으로 사용합니다.

1. **Authorize**: `chat.z.ai/api/oauth/authorize`로 로그인합니다. 리다이렉트가 `zcode://` 커스텀 프로토콜이라 사용자가 최종 URL을 직접 붙여넣습니다.
2. **Broker 교환**: `zcode.z.ai/api/v1/oauth/token`에서 authorization code를 upstream Z.AI 토큰으로 교환합니다.
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
