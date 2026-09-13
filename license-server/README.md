# EETO MIRACLE 무료 라이선스 서버

Cloudflare Workers와 D1 무료 플랜에서 동작하는 MIRACLE 온라인 활성화 서버입니다. 기존 정적 홈페이지와 별도로 배포합니다.

## 배포 방식

GitHub 저장소의 `main` 브랜치에 `license-server` 변경을 올리면 GitHub Actions가 D1 표를 갱신한 뒤 Worker를 자동 배포합니다. 배포용 Cloudflare 토큰은 GitHub Actions 비밀값 `CLOUDFLARE_API_TOKEN`에만 저장하며, 코드에는 포함하지 않습니다.

현재 Worker와 D1 정보는 `wrangler.toml`에 연결되어 있습니다. 이 정보는 공개되어도 되는 식별자이며, 관리자 키나 고객 라이선스 키는 포함하지 않습니다.

## 관리자 키 설정

아래 명령을 실행하면 관리자 키를 묻습니다. 길고 무작위인 값을 입력해 안전한 곳에 보관하십시오. 이 값은 GitHub 저장소에 절대 저장하지 않습니다.

```powershell
wrangler secret put ADMIN_API_KEY
```

`wrangler.toml`의 `CORS_ORIGIN`은 실제 홈페이지 주소로 변경합니다. 예: `https://eeto.co.kr`

관리자 키는 배포가 끝난 뒤 Cloudflare Worker의 **Settings → Variables and Secrets**에서도 추가할 수 있습니다. 출력된 Worker 주소를 MIRACLE의 라이선스 서버 주소로 사용합니다.

## 관리자 API

관리자 키는 `x-admin-key` 헤더로만 전달합니다. 브라우저 주소창이나 GitHub 코드에 넣지 마십시오.

### 라이선스 생성

```powershell
$headers = @{ "x-admin-key" = "관리자키"; "content-type" = "application/json" }
$body = @{ customerName = "고객사"; maxDevices = 1; expiresAt = "2027-12-31T23:59:59+09:00"; features = @("nc-output", "shared-cut") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://license.example.workers.dev/v1/admin/licenses" -Headers $headers -Body $body
```

응답에 한 번만 표시되는 `licenseKey`를 고객에게 전달합니다. 서버는 평문 키가 아닌 SHA-256 해시만 저장합니다.

### 기존 PC 활성화 해제

`GET /v1/admin/licenses`로 라이선스와 활성화 목록을 확인한 뒤, 해당 활성화 ID를 사용해 `POST /v1/admin/licenses/{licenseId}/revoke`를 호출합니다.

## 프로그램 연결 규칙

- 최초 활성화: `POST /v1/activate`
- 주기 확인: `POST /v1/check`
- PC 식별값은 프로그램이 만든 비가역 해시를 사용합니다.
- 성공 응답의 `checkUntil` 전까지 오프라인 사용을 허용합니다. 기본값은 7일입니다.
- 만료, 정지, 다른 PC 사용 또는 유예기간 종료 시 NC 출력과 핵심 기능을 차단합니다.

## 보안 원칙

- `ADMIN_API_KEY`, 고객 키, D1 덤프를 Git에 커밋하지 않습니다.
- 모든 요청은 HTTPS만 사용합니다.
- 관리자 API는 관리 화면에서만 호출하며 일반 프로그램에는 관리자 키를 포함하지 않습니다.
- 무료 한도 초과 시 활성화 확인만 잠시 실패할 수 있으므로, 프로그램은 마지막 정상 확인 후 7일의 오프라인 유예를 적용합니다.
