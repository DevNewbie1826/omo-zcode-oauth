# omo-zcode-oauth

[omo](https://github.com/code-yeongyu/omo) (pi-based CLI)용 **Zcode OAuth 확장(extension)** — 비공식(unofficial) GLM ZCode 로그인을 `glm-zcode` provider로 등록합니다.

> **Warning**: 이 프로젝트는 ZCode 데스크톱 앱의 로그인 플로우를 재현한 **비공식** 구현입니다. Z.AI / ZCode의 공식 OAuth 클라이언트가 아니며, ToS 위반 가능성이 있고 언제든 동작이 중단될 수 있습니다. 사용 책임은 사용자에게 있습니다.

## 배경 / 조사

구현에 앞서 feasibility 조사를 완료했습니다. 전체 보고서와 증거 자료는 [`docs/research/`](docs/research/)에 있습니다.

- **조사 보고서**: [docs/research/zcode-oauth-extension-research.md](docs/research/zcode-oauth-extension-research.md)
- **핵심 결론**: omo/pi **코어 수정 없이** 공개 ExtensionAPI(`pi.registerProvider` + `ProviderConfig.oauth`)만으로 외부 확장 구현이 가능합니다. [senpi PR #295](https://github.com/code-yeongyu/senpi/pull/295)(builtin 포팅)와 [gajae-code](https://github.com/Yeachan-Heo/gajae-code)(원본 구현)가 근거입니다.

## 동작 원리 (요약)

ZCode 앱의 로그인 플로우를 재현해 최종적으로 **Z.AI 대시보드 API 키**(`{id}.{secret}`)를 프로비저닝하고, 이 키로 `https://api.z.ai/api/anthropic`(Anthropic 호환)에 Bearer 인증합니다.

1. **Authorize** — `chat.z.ai/api/oauth/authorize` (리다이렉트가 `zcode://` 커스텀 프로토콜이라 사용자가 최종 URL 수동 붙여넣기)
2. **Broker 교환** — `zcode.z.ai/api/v1/oauth/token` → upstream Z.AI 토큰
3. **Business 로그인** — `api.z.ai/api/auth/z/login` → business 토큰
4. **API 키 프로비저닝** — `getCustomerInfo` → `api_keys` 조회/생성(`zcode-api-key`) → `api_keys/copy/{id}` → 최종 키

## Status

현재 개발 진행 중입니다. 설치/사용 방법은 첫 릴리스와 함께 이 문서에 추가됩니다.

## License

MIT (예정)
