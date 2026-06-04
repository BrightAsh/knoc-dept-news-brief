# 모델 및 API 키 설정

현재 추천 구성은 Groq API의 Llama 모델을 1차/2차에 나눠 쓰는 방식입니다.

## 추천 모델

| 단계 | 모델 | 이유 |
|---|---|---|
| 1차 분류 | `meta-llama/llama-4-scout-17b-16e-instruct` | 전체 기사를 넓게 훑고 후보를 남기는 용도. 실제 테스트에서 8B보다 TPM 여유가 필요했습니다. |
| 2차 분류 | `meta-llama/llama-4-scout-17b-16e-instruct` | 1차 결과를 본문 기반으로 재검토하고 최종 부서 배정하는 용도. 무료 토큰 한도가 비교적 넉넉합니다. |
| fallback | `llama-3.1-8b-instant` | 빠르지만 무료 TPM이 낮습니다. batch와 입력 길이를 크게 줄여야 합니다. |
| 2차 정밀 옵션 | `llama-3.3-70b-versatile` | 품질은 좋지만 무료 TPD가 낮습니다. 전체 D 그룹 재검토보다는 후보 기사 정밀 검토에 적합합니다. |

실제 2026-06-03 전체 실행에서 `llama-3.1-8b-instant`는 무료 TPM 6000 한도에 걸렸습니다. 그래서 1차 모델이 이 값으로 설정돼 있으면, `STAGE1_ALLOW_LOW_TPM=true`가 아닌 한 코드가 자동으로 `meta-llama/llama-4-scout-17b-16e-instruct`로 올려 실행합니다.

## Groq API 키 발급

1. [Groq Console](https://console.groq.com/)에 로그인합니다.
2. `API Keys` 메뉴로 이동합니다.
3. `Create API Key`를 누릅니다.
4. 생성된 키를 복사합니다.
5. 키는 다시 확인하기 어렵기 때문에 GitHub Secret에 바로 저장합니다.

## GitHub 저장소에 넣을 값

GitHub 저장소에서 `Settings` → `Secrets and variables` → `Actions`로 이동합니다.

### Secrets

`New repository secret`에 아래 값을 추가합니다.

```text
GROQ_API_KEY = 발급받은 Groq API key
```

API key는 Secret에만 넣습니다. 코드, README, data 파일에는 넣지 않습니다.

### Variables

`Variables` 탭에서 아래 값을 추가합니다.

```text
STAGE1_PROVIDER = groq
STAGE1_MODEL = meta-llama/llama-4-scout-17b-16e-instruct
STAGE1_BATCH_SIZE = 16
STAGE1_MAX_TOKENS = 1400
STAGE1_MAX_ARTICLES = 0

STAGE2_PROVIDER = groq
STAGE2_MODEL = meta-llama/llama-4-scout-17b-16e-instruct
STAGE2_BATCH_SIZE = 8
STAGE2_MAX_TOKENS = 3200
STAGE2_MAX_ARTICLES = 0
STAGE2_REVIEW_REJECTED = true
LLM_REQUEST_TIMEOUT_MS = 45000
LLM_RATE_LIMIT_RETRIES = 2
LLM_FAIL_ON_ERROR = true
LLM_DEBUG = true
```

LLM 오류가 나도 raw 응답과 partial 결과를 보존합니다. 저장 위치와 재실행 순서는 [debug-and-retry.md](debug-and-retry.md)를 봅니다.

`MAX_ARTICLES = 0`은 전체 기사를 처리한다는 뜻입니다.

## 비용 방지

무료 한도 안에서만 쓰려면 Groq에서 결제 수단이나 paid plan을 추가하지 않습니다. 무료 한도를 넘으면 요청이 실패하거나 rate limit이 발생하도록 두는 방식입니다.

GitHub Models를 쓸 때도 paid usage를 켜지 않으면 무료 quota 소진 후 사용이 막히는 구조입니다. 돈이 나가지 않게 하려면 paid usage를 켜지 않습니다.

## 모델 교체 방법

코드 수정 없이 GitHub Actions variables만 바꾸면 됩니다.

예: 1차를 빠른 fallback 모델로 변경

```text
STAGE1_MODEL = llama-3.1-8b-instant
STAGE1_BATCH_SIZE = 1
STAGE1_ALLOW_LOW_TPM = true
```

예: 2차를 70B 정밀 모델로 변경

```text
STAGE2_MODEL = llama-3.3-70b-versatile
STAGE2_REVIEW_REJECTED = false
```

예: GitHub Models로 변경

```text
STAGE1_PROVIDER = github-models
STAGE1_MODEL = openai/gpt-4.1-mini
STAGE2_PROVIDER = github-models
STAGE2_MODEL = openai/gpt-4.1
```

GitHub Models는 workflow의 `GITHUB_TOKEN`을 사용하므로 Actions 안에서는 별도 token 없이 동작할 수 있습니다. 다만 모델별 접근 권한과 무료 한도는 계정 상태에 따라 다를 수 있습니다.

## 로컬 테스트

PowerShell에서:

```powershell
$env:GROQ_API_KEY="발급받은 Groq API key"
$env:STAGE1_PROVIDER="groq"
$env:STAGE1_MODEL="meta-llama/llama-4-scout-17b-16e-instruct"
$env:STAGE2_PROVIDER="groq"
$env:STAGE2_MODEL="meta-llama/llama-4-scout-17b-16e-instruct"
node scripts/analyze.mjs --date 2026-06-03 --stage1-max-articles 10 --stage2-max-articles 10
```

먼저 10건 정도만 테스트한 뒤 결과가 괜찮으면 `MAX_ARTICLES` 제한을 풀어 전체 실행합니다.
