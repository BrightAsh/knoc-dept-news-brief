# LLM 옵션

이 프로젝트는 모델을 코드에 고정하지 않고 환경변수로 교체합니다. 현재 분석은 1차와 2차가 분리되어 있습니다.

## 기본 추천

| 단계 | Provider | Model |
|---|---|---|
| 1차 후보 검토 | `groq` | `llama-3.1-8b-instant` |
| 2차 최종 검토 | `groq` | `meta-llama/llama-4-scout-17b-16e-instruct` |

## 환경변수

```text
STAGE1_PROVIDER=groq
STAGE1_MODEL=llama-3.1-8b-instant
STAGE1_BATCH_SIZE=8
STAGE1_MAX_ARTICLES=0

STAGE2_PROVIDER=groq
STAGE2_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
STAGE2_BATCH_SIZE=4
STAGE2_MAX_ARTICLES=0
STAGE2_REVIEW_REJECTED=true
```

## 지원 provider

### `groq`

Groq OpenAI-compatible API를 사용합니다.

필수 Secret:

```text
GROQ_API_KEY
```

### `github-models`

GitHub Models API를 사용합니다. GitHub Actions에서는 workflow의 `GITHUB_TOKEN`과 `permissions: models: read`로 호출합니다.

로컬에서 테스트하려면 GitHub fine-grained token에 `Models: read` 권한을 줘서 `GITHUB_MODELS_TOKEN`으로 넣습니다.

### `ollama`

로컬 또는 self-hosted runner의 Ollama 서버를 사용합니다.

```text
STAGE1_PROVIDER=ollama
STAGE1_MODEL=llama3.1:8b
OLLAMA_BASE_URL=http://localhost:11434/v1
```

GitHub-hosted Actions에서는 로컬 Ollama가 없으므로 self-hosted runner가 필요합니다.

### `openai-compatible`

OpenAI-compatible endpoint를 직접 지정합니다.

```text
STAGE1_PROVIDER=openai-compatible
STAGE1_MODEL=사용할 모델명
LLM_BASE_URL=https://example.com/v1
LLM_API_KEY=provider api key
```

## 운영 팁

- 1차는 누락 방지가 목표라 빠르고 한도가 넉넉한 모델을 씁니다.
- 2차는 최종 부서 배정이 목표라 1차보다 좋은 모델을 씁니다.
- 무료 한도를 아끼려면 먼저 `STAGE1_MAX_ARTICLES=20`, `STAGE2_MAX_ARTICLES=20`으로 테스트합니다.
- `STAGE2_REVIEW_REJECTED=true`이면 1차에서 제외한 기사도 2차에서 다시 봅니다. 정확도는 올라가지만 호출량이 늘어납니다.
