# EETO MIRACLE 무료 라이선스 서버

Cloudflare Workers와 D1 무료 플랜에서 동작하는 MIRACLE 온라인 활성화 서버입니다. 기존 정적 홈페이지와 별도로 배포합니다.

## 배포 방식

GitHub 저장소의 `main` 브랜치에 `license-server` 변경을 올리면 GitHub Actions가 D1 표를 갱신한 뒤 Worker를 자동 배포합니다. 배포용 Cloudflare 토큰은 GitHub Actions 비밀값 `CLOUDFLARE_API_TOKEN`에만 저장하며, 코드에는 포함하지 않습니다.

현재 Worker와 D1 정보는 `wrangler.toml`에 연결되어 있습니다. 이 정보는 공개되어도 되는 식별자이며, 관리자 키나 고객 라이선스 키는 포함하지 않습니다.

## 관리자 키 설정

관리 화면의 **관리자 키 변경**에서 현재 키 인증 후 새 키를 지정할 수 있습니다.
새 키는 공백 없는 ASCII 12~128자이며 자동 생성 기능을 권장합니다.
D1 `admin_credentials`에는 SHA-256 해시만 저장하고, 브라우저 저장소에는 키를 저장하지 않습니다.
변경 즉시 이전 키는 거부됩니다. 고객 라이선스와 PC 활성화는 변경하지 않습니다.
키를 잊었다면 아래 방법으로 Cloudflare의 `ADMIN_API_KEY`를 **새로운 값**으로 교체하세요.
서버 비밀값이 변경되면 이전 웹 설정 키는 무효가 되고 새 비밀값으로 복구됩니다.

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

발급된 `licenseKey`를 고객에게 전달합니다. 인증에는 SHA-256 해시를 사용하며, 관리자 목록 표시를 위해 별도의 key_value도 보관하므로 데이터베이스와 관리자 권한을 보호해야 합니다.

### 기존 PC 활성화 해제

`GET /v1/admin/licenses`로 라이선스와 활성화 목록을 확인한 뒤, 해당 활성화 ID를 사용해 `POST /v1/admin/licenses/{licenseId}/revoke`를 호출합니다.

## 프로그램 연결 규칙 (동시 사용 v2)

- 허용 대수는 설치/등록 대수가 아니라 현재 사용 중인 PC 수입니다.
- 프로세스마다 새 sessionId를 만들고 protocolVersion=2를 전송합니다.
- 실행 시: 저장된 활성화 토큰으로 POST /v1/check, purpose=startup. 최초 키 입력은 /v1/activate.
- NC 내보내기 직전: POST /v1/check, purpose=nc-export. 사용권을 새로 획득하지 않고 현재 세션만 확인합니다.
- 정상 종료: POST /v1/release로 해당 프로세스 사용권만 반환합니다. 추가 인증 요청이 아닙니다.
- 주기 조회/자동 만료/오프라인 유예는 없습니다. 응답 checkUntil은 캐시 인증에 사용하지 않습니다.
- 같은 PC의 여러 프로세스는 1대이며, 마지막 프로세스가 종료되어야 다른 PC에 자리가 납니다.
- 비정상 종료/종료 시 통신 실패는 관리자 화면의 ‘사용 중 PC / 해제’에서 해당 PC를 명시적으로 해제합니다.
- 해제된 프로세스는 다음 NC 내보내기가 거부됩니다. WS 저장 후 재실행하여 새 세션을 획득해야 합니다.
- 중지/만료/PC 인증 해제는 영구락보다 우선합니다. 작업 중인 프로그램은 다음 NC 내보내기에 반영됩니다.
- 관리 API: GET /v1/admin/licenses/{id}/sessions, POST /v1/admin/licenses/{id}/release-device (activationId).
- 0004-concurrent-sessions.sql을 적용한 서버와 v2 클라이언트를 함께 배포해야 합니다. 구형 클라이언트 요청은 426으로 업데이트를 안내합니다. 구형 오프라인 실행 파일 자체를 원격 변경할 수 없으므로 모든 PC에 새 버전을 설치해야 합니다.
- 테스트: Node.js 24에서 각 *.test.mjs 실행. device-limit.test.mjs는 메모리 SQLite와 실제 Worker 라우트를 사용하며 운영 고객 데이터에 접근하지 않습니다.

## 보안 원칙

- `ADMIN_API_KEY`, 고객 키, D1 덤프를 Git에 커밋하지 않습니다.
- 모든 요청은 HTTPS만 사용합니다.
- 관리자 API는 관리 화면에서만 호출하며 일반 프로그램에는 관리자 키를 포함하지 않습니다.
- 서버 연결 실패 시 실행과 NC 내보내기는 승인하지 않습니다. 이미 열린 작업 데이터는 삭제하지 않습니다.
