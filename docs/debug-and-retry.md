# Debug and Retry Policy

LLM 토큰을 썼는데 결과가 사라지는 일을 막기 위한 운영 규칙입니다.

## 저장되는 파일

분석 실행 중 `data/YYYY-MM-DD/debug/` 아래에 batch별 파일을 저장합니다.

```text
stage1-batch-001-root-try-01-input.json
stage1-batch-001-root-try-01-response-summary.json
stage1-batch-001-root-try-01-raw-content.txt
stage1-batch-001-root-try-01-raw-response.json
stage1-batch-001-root-try-01-parsed.json
stage1-batch-001-root-try-01-normalized.json
stage1-batch-001-root-try-01-error.json
```

- `input.json`: batch 기사, segment, stage0/stage1 상태 요약
- `response-summary.json`: 모델명, usage, finish_reason 등 응답 요약
- `raw-content.txt`: 모델 message content 원문
- `raw-response.json`: provider HTTP 응답 원문
- `parsed.json`: raw content에서 추출한 JSON
- `normalized.json`: 내부 schema로 받아들인 결과와 탈락한 raw result
- `error.json`: HTTP, timeout, JSON parse, schema 처리 오류

## Partial 저장

각 batch가 끝날 때마다 아래 파일을 갱신합니다.

```text
data/YYYY-MM-DD/stage1.partial.json
data/YYYY-MM-DD/stage2.partial.json
```

분석이 중간에 실패해도 성공한 batch 결과는 이 파일에 남습니다.

## Workflow 실패와 로그 보존

`scripts/analyze.mjs`가 실패해도 GitHub Actions는 먼저 `data/`를 커밋합니다. 그 다음 workflow를 실패 처리합니다. 따라서 LLM 오류가 나도 debug 파일은 GitHub에 남습니다.

## 내일 재실행 순서

처음부터 전체 실행하지 않습니다.

1. `workflow_dispatch`에서 `stage1_max_articles=10`, `stage2_max_articles=10`으로 실행합니다.
2. `debug/`의 raw content와 parsed/normalized 결과를 확인합니다.
3. schema나 부서 id 매칭 문제가 있으면 코드를 고칩니다.
4. 샘플이 정상일 때만 `stage1_max_articles=0`, `stage2_max_articles=0`으로 전체 실행합니다.

## 중요한 운영값

```text
LLM_DEBUG=true
LLM_FAIL_ON_ERROR=true
LLM_REQUEST_TIMEOUT_MS=45000
LLM_RATE_LIMIT_RETRIES=2
```
