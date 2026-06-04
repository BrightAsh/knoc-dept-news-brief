# KNOC Department News Brief

한국석유공사 부서별 맞춤 언론보도 브리핑을 만들기 위한 날짜 기반 수집·분석·정적 웹 UI입니다.

사이트: [https://brightash.github.io/knoc-dept-news-brief/](https://brightash.github.io/knoc-dept-news-brief/)

## 현재 흐름

1. `scripts/collect.mjs`가 5개 대형 언론사의 RSS/sitemap에서 특정 날짜 기사를 수집합니다.
2. `scripts/analyze.mjs`가 0차 키워드 라우팅, 1차 LLM 검토, 2차 LLM 최종 검토를 수행합니다.
3. 최종 결과는 `briefs.json`에 저장되고, 중간 결과는 `stage0.json`, `stage1.json`, `stage2.json`에 남습니다.
4. GitHub Pages UI는 날짜별 기사 수, 전체 관련 기사, 부서별 배정 근거를 보여줍니다.

## 분석 파이프라인

```text
articles.json
  -> stage0.json  0차: 키워드 기반 A/B 라우팅
  -> stage1.json  1차: Llama 기반 후보 검토 및 부서 후보 배정
  -> stage2.json  2차: Llama 기반 본문 재검토 및 최종 부서 배정
  -> briefs.json  UI가 읽는 최종 결과
```

0차 키워드는 `한국석유공사`, `석유`, `공공기관`처럼 확실한 단어로 A/B 그룹을 나누는 용도입니다. 최종 관련성 판단이나 부서 배정은 키워드가 아니라 LLM이 한국석유공사의 역할과 22개 부서 업무 설명을 함께 보고 판단합니다.

자세한 설계는 [docs/analysis-pipeline.md](docs/analysis-pipeline.md)를 봅니다.

## 실행

```bash
node scripts/collect.mjs --date 2026-06-01 --include-body --body-concurrency 6
node scripts/analyze.mjs --date 2026-06-01
```

전일 자료 수집 및 분석:

```bash
node scripts/collect.mjs --date yesterday --include-body --body-concurrency 6
node scripts/analyze.mjs --date yesterday
```

## Llama 모델 설정

현재 기본 설계는 Groq API의 Llama 모델을 사용합니다.

| 단계 | 기본 모델 | 역할 |
|---|---|---|
| 1차 | `meta-llama/llama-4-scout-17b-16e-instruct` | A/B 그룹 전체를 훑고 후보 기사와 부서 후보를 찾음 |
| 2차 | `meta-llama/llama-4-scout-17b-16e-instruct` | 1차 후보와 1차 제외 기사를 본문 기반으로 재검토하고 최종 부서 배정 |

GitHub 저장소 `Settings` → `Secrets and variables` → `Actions`에서 아래 값을 설정합니다.

Secrets:

```text
GROQ_API_KEY = Groq에서 발급받은 API key
```

Variables:

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
```

설정 방법은 [docs/model-setup.md](docs/model-setup.md)에 정리되어 있습니다.

## GitHub Actions

`.github/workflows/daily-collect.yml`이 매일 00:05 KST에 전일 기사를 수집·분석하고 `data/`에 커밋합니다. GitHub cron은 UTC 기준이므로 workflow에는 `15:05 UTC`로 설정되어 있습니다.

## 출력 구조

```text
data/
  YYYY-MM-DD/
    articles.json
    stage0.json
    stage1.json
    stage2.json
    briefs.json
    run.json
  index.json
```

- `articles.json`: 해당 날짜 기사 목록과 본문 일부
- `stage0.json`: 키워드 라우팅 결과, A/B 그룹
- `stage1.json`: 1차 LLM 후보 검토 결과
- `stage2.json`: 2차 LLM 최종 검토 결과
- `briefs.json`: UI가 읽는 최종 전체/부서별 브리핑
- `run.json`: 수집 실행 로그와 언론사별 통계
- `index.json`: 날짜별 UI 인덱스

## 언론사 소스

설정은 `config/sources.json`에 있습니다.

- 조선일보: RSS + 뉴스 sitemap
- 중앙일보: 최신기사 sitemap
- 동아일보: RSS
- 한겨레: 섹션 RSS
- 경향신문: RSS + 최신기사 sitemap
