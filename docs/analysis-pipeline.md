# 부서별 언론보도 분석 설계

## 목표

수집된 기사 전체를 그대로 요약하지 않는다. 기사 안의 제목, 요약, 본문 문장·문단을 작은 조각으로 나누고, 한국석유공사 22개 부서 중 실제로 볼 필요가 있는 부서에만 근거 조각을 연결한다.

## 핵심 흐름

```text
articles.json
  -> segment
  -> department match
  -> evidence select
  -> department brief
  -> briefs.json
  -> calendar UI
```

## 현재 구현

현재는 `scripts/analyze.mjs`가 LLM 대신 규칙 기반 분석기처럼 동작한다.

- 입력: `data/YYYY-MM-DD/articles.json`
- 부서 프로필: `config/departments.json`
- 출력: `data/YYYY-MM-DD/briefs.json`
- 분석기 이름: `rule-keyword-v0`

규칙 기반 분석기는 기사 제목·RSS 요약·본문 후보에서 부서 키워드를 찾고, 점수가 일정 기준 이상이면 부서별 후보로 묶는다. 이 단계는 정확한 최종 분석이라기보다 UI와 데이터 구조를 먼저 고정하기 위한 PoC다.

## LLM으로 바꿀 위치

향후에는 `rule-keyword-v0` 자리에 LLM 분석기를 둔다. UI와 저장 파일 모양은 유지한다.

```text
rule-keyword-v0
  -> llm-segment-classifier-v1
  -> llm-evidence-brief-v1
```

## LLM 역할

| 역할 | 설명 | 출력 |
|---|---|---|
| Segmenter | 기사 본문을 문장·문단 조각으로 나눔 | segments |
| Department Classifier | 각 조각이 어떤 부서에 필요한지 판단 | department_matches |
| Evidence Selector | 부서가 볼 만한 근거 조각만 남김 | evidence items |
| Brief Writer | 부서별로 여러 기사 조각을 묶어 짧은 브리핑 작성 | department brief |
| Reviewer | 근거 없는 단정, 오분류, 중복을 점검 | reviewed brief |

## briefs.json 스키마

```json
{
  "target_date": "2026-06-01",
  "generated_at": "2026-06-02T00:00:00.000Z",
  "analyzer": "rule-keyword-v0",
  "input_article_count": 755,
  "relevant_article_count": 151,
  "relevant_department_count": 18,
  "departments": [
    {
      "department_id": "she",
      "department": "SHE추진실",
      "role": "전사 안전·보건·환경 및 재난 전략·정책...",
      "article_count": 45,
      "segment_count": 64,
      "top_keywords": [{ "keyword": "사고", "count": 31 }],
      "items": [
        {
          "article_id": "string",
          "publisher": "조선일보",
          "title": "기사 제목",
          "url": "https://...",
          "score": 10.08,
          "matched_keywords": ["안전", "보건", "중대재해"],
          "segment_text": "부서가 볼 필요가 있는 문장 또는 문단",
          "reason": "왜 이 부서와 연결되는지",
          "evidence_type": "direct"
        }
      ]
    }
  ]
}
```

## 왜 기사 단위가 아니라 문장·문단 단위인가

한 기사 전체가 한 부서에 필요한 경우는 드물다. 예를 들어 원유 가격 기사 안에서도 재무처가 볼 문장, 스마트데이터센터가 볼 문장, 석유사업처가 볼 문장이 다르다. 그래서 기사 전체 요약보다 근거 조각을 부서별로 라우팅하는 방식이 더 적합하다.

## 다음 구현 순서

1. 본문 추출 정확도 개선
2. `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` 환경변수 기반 adapter 추가
3. LLM이 `briefs.json` 스키마로 직접 출력하게 만들기
4. 규칙 기반 결과와 LLM 결과를 나란히 비교하는 검수 화면 추가
5. 부서별 중요도, 제외 키워드, 관심 키워드를 UI에서 조정 가능하게 만들기
