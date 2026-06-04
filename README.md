# KNOC Department News Brief

한국석유공사 부서별 언론보도 브리프를 만들기 위한 날짜 기반 수집·분석·정적 웹 UI입니다.

사이트: [https://brightash.github.io/knoc-dept-news-brief/](https://brightash.github.io/knoc-dept-news-brief/)

현재 흐름은 다음과 같습니다.

1. `scripts/collect.mjs`가 5개 언론사의 RSS/sitemap에서 특정 날짜 기사를 수집합니다.
2. `scripts/analyze.mjs`가 기사 제목·요약·본문 문단을 부서 업무와 매칭합니다.
3. LLM이 설정되어 있으면 후보 기사에 대해 회사 관련성, 부서, 근거 문장/문단을 문맥 검토합니다.
4. `index.html`이 GitHub Pages에서 달력, 전체 기사 후보, 부서별 근거를 보여줍니다.

## 실행

```bash
node scripts/collect.mjs --date 2026-06-01
node scripts/analyze.mjs --date 2026-06-01
```

본문 문단까지 저장:

```bash
node scripts/collect.mjs --date 2026-06-01 --include-body --body-concurrency 6
```

전날 자료 수집:

```bash
node scripts/collect.mjs --date yesterday --include-body
node scripts/analyze.mjs --date yesterday
```

## LLM 설정

기본 설계는 GitHub Actions에서 `GITHUB_TOKEN`으로 GitHub Models를 호출하는 방식입니다. 모델은 환경변수로 교체합니다.

```text
LLM_PROVIDER=github-models
LLM_MODEL=meta/meta-llama-3.1-8b-instruct
LLM_MAX_ARTICLES=80
LLM_BATCH_SIZE=8
```

지원 provider:

- `rule`: LLM 없이 규칙 기반 분석만 수행
- `github-models`: GitHub Models API 사용
- `groq`: Groq OpenAI-compatible API 사용
- `ollama`: 로컬 Ollama 사용
- `openai-compatible`: 임의의 OpenAI 호환 API 사용

자세한 후보 비교는 [docs/llm-options.md](docs/llm-options.md)를 참고합니다.

## 출력 구조

```text
data/
  YYYY-MM-DD/
    articles.json
    briefs.json
    run.json
  index.json
```

- `articles.json`: 해당 날짜 기사 목록과 본문 후보 문단
- `briefs.json`: 전체 회사 관련 기사 후보와 부서별 근거
- `run.json`: 수집 실행 로그와 언론사별 통계
- `index.json`: 날짜별 웹 UI 인덱스

## 언론사 소스

설정은 `config/sources.json`에 있습니다.

- 조선일보: RSS + 뉴스 sitemap
- 중앙일보: 최신기사 sitemap
- 동아일보: RSS
- 한겨레: 섹션 RSS
- 경향신문: RSS + 최신기사 sitemap

## 다음 단계

- LLM 검토 결과를 문장/문단/전체기사 단위로 더 명확히 분리
- 부서별 요약문 생성
- 기사 본문 추출 품질 개선
- GitHub Pages 화면에서 날짜별 변화 추이 추가
