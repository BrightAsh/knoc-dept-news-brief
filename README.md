# KNOC Department News Brief

한국석유공사 부서별 언론보도 브리핑을 위한 날짜 기반 수집기입니다.

현재 단계는 웹 UI나 LLM 요약 전 단계입니다. 특정 날짜를 입력하면 5개 언론사의 RSS/sitemap에서 해당 날짜 기사 메타데이터를 수집하고 `data/YYYY-MM-DD/` 아래에 저장합니다.

## 간단 웹 화면

`index.html`은 정적 페이지입니다. GitHub Pages에 올리면 달력 형태로 날짜별 기사 수를 보여주고, 날짜를 누르면 하단에 해당 날짜 기사 목록이 표시됩니다.

## 실행

```bash
node scripts/collect.mjs --date 2026-06-01
```

전날 수집:

```bash
node scripts/collect.mjs --date yesterday
```

본문까지 저장:

```bash
node scripts/collect.mjs --date 2026-06-01 --include-body
```

기본값은 저작권 리스크를 줄이기 위해 기사 본문을 저장하지 않습니다. `--include-body`를 줄 때만 기사 페이지의 본문 후보 문단을 저장합니다.

## 출력

```text
data/
  2026-06-01/
    articles.json
    run.json
  index.json
```

- `articles.json`: 해당 날짜 기사 목록
- `run.json`: 수집 실행 로그와 소스별 통계
- `index.json`: 날짜별 실행 인덱스

## 수집 소스

설정은 `config/sources.json`에 있습니다.

- 조선일보: RSS + 뉴스 sitemap
- 중앙일보: 최신기사 sitemap
- 동아일보: RSS
- 한겨레: 섹션 RSS
- 경향신문: RSS + 최신기사 sitemap

## 다음 단계

- 기사 본문 추출 정확도 개선
- 한국석유공사 22개 부서 프로필 연결
- 문장·문단 단위 부서 매칭
- LLM provider adapter 추가
- GitHub Actions로 매일 00:05 KST에 전날 자료 자동 수집
