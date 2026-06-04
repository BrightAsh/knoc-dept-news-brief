import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient } from "./llm-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const departmentsPath = path.join(rootDir, "config", "departments.json");
const knocContextPath = path.join(rootDir, "config", "knoc-context.json");
const stage0KeywordsPath = path.join(rootDir, "config", "stage0-keywords.json");
const analyzerVersion = "knoc-two-pass-llm-v1";
const timeZone = "Asia/Seoul";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDate = resolveTargetDate(args.date || "yesterday");
  const dayDir = path.join(dataDir, targetDate);

  const articles = JSON.parse(await fs.readFile(path.join(dayDir, "articles.json"), "utf8"));
  const departments = JSON.parse(await fs.readFile(departmentsPath, "utf8"));
  const knocContext = JSON.parse(await fs.readFile(knocContextPath, "utf8"));
  const stage0Keywords = JSON.parse(await fs.readFile(stage0KeywordsPath, "utf8"));

  const maxItemsPerDepartment = Number(args.maxItemsPerDepartment || 80);
  const maxOverallItems = Number(args.maxOverallItems || 200);

  const stage0 = runStage0({ targetDate, articles, keywordConfig: stage0Keywords });
  await writeJson(path.join(dayDir, "stage0.json"), stage0);

  const stage1Setup = createStageClient("STAGE1", {
    provider: process.env.LLM_PROVIDER || "none",
    model: process.env.LLM_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct"
  });
  const stage1 = stage1Setup.client
    ? await runStage1({
        targetDate,
        client: stage1Setup.client,
        articles,
        stage0,
        departments,
        knocContext,
        batchSize: Number(args.stage1BatchSize || process.env.STAGE1_BATCH_SIZE || process.env.LLM_BATCH_SIZE || 8),
        maxArticles: Number(args.stage1MaxArticles ?? process.env.STAGE1_MAX_ARTICLES ?? process.env.LLM_MAX_ARTICLES ?? 0)
      })
    : disabledStage({
        targetDate,
        stage: "stage1",
        setup: stage1Setup,
        requestedArticleCount: articles.length
      });
  await writeJson(path.join(dayDir, "stage1.json"), stage1);

  const stage2Setup = createStageClient("STAGE2", {
    provider: stage1Setup.provider || process.env.LLM_PROVIDER || "none",
    model: process.env.STAGE2_MODEL || process.env.LLM_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct"
  });
  const stage2Inputs = buildStage2Inputs({
    articles,
    stage0,
    stage1,
    reviewRejected: booleanEnv(process.env.STAGE2_REVIEW_REJECTED, true),
    maxRejected: Number(args.stage2MaxRejected ?? process.env.STAGE2_MAX_REJECTED ?? 0)
  });
  const stage2 = stage2Setup.client
    ? await runStage2({
        targetDate,
        client: stage2Setup.client,
        inputs: stage2Inputs,
        departments,
        knocContext,
        batchSize: Number(args.stage2BatchSize || process.env.STAGE2_BATCH_SIZE || 4),
        maxArticles: Number(args.stage2MaxArticles ?? process.env.STAGE2_MAX_ARTICLES ?? 0)
      })
    : disabledStage({
        targetDate,
        stage: "stage2",
        setup: stage2Setup,
        requestedArticleCount: stage2Inputs.length
      });
  await writeJson(path.join(dayDir, "stage2.json"), stage2);

  const briefs = buildBriefs({
    targetDate,
    articles,
    departments,
    stage0,
    stage1,
    stage2,
    maxItemsPerDepartment,
    maxOverallItems
  });

  await writeJson(path.join(dayDir, "briefs.json"), briefs);
  await updateIndex(targetDate, briefs);

  console.log(
    JSON.stringify(
      {
        target_date: targetDate,
        analyzer: analyzerVersion,
        input_article_count: articles.length,
        stage0_keyword_hit_count: stage0.keyword_hit_count,
        stage0_keyword_miss_count: stage0.keyword_miss_count,
        stage1_status: stage1.status,
        stage1_candidate_count: stage1.candidate_count || 0,
        stage2_status: stage2.status,
        final_relevant_article_count: briefs.relevant_article_count,
        relevant_department_count: briefs.relevant_department_count,
        output: `data/${targetDate}/briefs.json`
      },
      null,
      2
    )
  );
}

function runStage0({ targetDate, articles, keywordConfig }) {
  const keywordEntries = normalizeKeywordEntries(keywordConfig);
  const items = articles.map((article) => {
    const matches = matchStage0Keywords(article, keywordEntries);
    return {
      article_id: article.id,
      group: matches.length ? "A" : "B",
      group_label: matches.length ? "keyword_hit" : "keyword_miss",
      matched_terms: matches.map((match) => match.term),
      matched_categories: [...new Set(matches.map((match) => match.category).filter(Boolean))]
    };
  });

  const keywordHitCount = items.filter((item) => item.group === "A").length;
  return {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: "stage0-keyword-router-v1",
    purpose: "A/B routing only. Keyword hits are not final relevance decisions.",
    input_article_count: articles.length,
    keyword_hit_count: keywordHitCount,
    keyword_miss_count: articles.length - keywordHitCount,
    items
  };
}

async function runStage1({ targetDate, client, articles, stage0, departments, knocContext, batchSize, maxArticles }) {
  const stage0Map = new Map(stage0.items.map((item) => [item.article_id, item]));
  const inputs = articles.map((article) => ({
    article,
    stage0: stage0Map.get(article.id),
    segments: segmentArticle(article, { maxSegments: 3, maxTextChars: 520, maxSegmentChars: 240 })
  }));
  const selected = maxArticles > 0 ? inputs.slice(0, maxArticles) : inputs;
  const review = createReview({
    targetDate,
    stage: "stage1",
    client,
    requestedArticleCount: selected.length,
    batchSize
  });

  if (!selected.length) {
    review.status = "empty";
    return finalizeStage1(review);
  }

  const batches = chunk(selected, Math.max(1, batchSize));
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(
      JSON.stringify({
        stage: "stage1",
        batch: index + 1,
        batch_count: batches.length,
        article_count: batch.length,
        model: client.model
      })
    );
    const outcome = await runLlmBatchWithSplit({
      batch,
      review,
      request: (items) =>
        client.chatJson(buildStage1Messages(items, departments, knocContext), {
        maxTokens: Number(process.env.STAGE1_MAX_TOKENS || 1400),
        temperature: 0.05
      }),
      normalize: (result, items) => normalizeStage1Result(result, items, departments)
    });
    review.results.push(...outcome.results);
    review.analyzed_article_count += outcome.analyzedCount;
    review.errors.push(...outcome.errors);
  }

  if (review.errors.length) review.status = review.results.length ? "partial" : "error";
  if (review.status === "ok" && review.analyzed_article_count < selected.length) review.status = "partial";
  return finalizeStage1(review);
}

async function runStage2({ targetDate, client, inputs, departments, knocContext, batchSize, maxArticles }) {
  const selected = maxArticles > 0 ? inputs.slice(0, maxArticles) : inputs;
  const review = createReview({
    targetDate,
    stage: "stage2",
    client,
    requestedArticleCount: selected.length,
    batchSize
  });

  if (!selected.length) {
    review.status = "empty";
    return finalizeStage2(review);
  }

  const batches = chunk(selected, Math.max(1, batchSize));
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(
      JSON.stringify({
        stage: "stage2",
        batch: index + 1,
        batch_count: batches.length,
        article_count: batch.length,
        model: client.model
      })
    );
    const outcome = await runLlmBatchWithSplit({
      batch,
      review,
      request: (items) =>
        client.chatJson(buildStage2Messages(items, departments, knocContext), {
        maxTokens: Number(process.env.STAGE2_MAX_TOKENS || 3200),
        temperature: 0.05
      }),
      normalize: (result, items) => normalizeStage2Result(result, items, departments)
    });
    review.results.push(...outcome.results);
    review.analyzed_article_count += outcome.analyzedCount;
    review.errors.push(...outcome.errors);
  }

  if (review.errors.length) review.status = review.results.length ? "partial" : "error";
  if (review.status === "ok" && review.analyzed_article_count < selected.length) review.status = "partial";
  return finalizeStage2(review);
}

async function runLlmBatchWithSplit({ batch, request, normalize, review, attempt = 0 }) {
  try {
    const payload = await request(batch);
    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const results = [];
    for (const result of rawResults) {
      const normalized = normalize(result, batch);
      if (normalized) results.push(normalized);
    }
    return { results, analyzedCount: batch.length, errors: [] };
  } catch (error) {
    const message = messageOf(error);
    if (shouldRetryRateLimit(message) && attempt < Number(process.env.LLM_RATE_LIMIT_RETRIES || 2)) {
      const waitMs = retryDelayMs(message);
      review.warnings.push(`Retry batch after LLM rate limit in ${Math.round(waitMs / 1000)}s: ${message.slice(0, 220)}`);
      await delay(waitMs);
      return runLlmBatchWithSplit({ batch, request, normalize, review, attempt: attempt + 1 });
    }
    if (batch.length > 1 && shouldSplitBatch(message)) {
      review.warnings.push(`Split ${batch.length} article batch after LLM size error: ${message.slice(0, 220)}`);
      const midpoint = Math.ceil(batch.length / 2);
      const left = await runLlmBatchWithSplit({
        batch: batch.slice(0, midpoint),
        request,
        normalize,
        review
      });
      const right = await runLlmBatchWithSplit({
        batch: batch.slice(midpoint),
        request,
        normalize,
        review
      });
      return {
        results: [...left.results, ...right.results],
        analyzedCount: left.analyzedCount + right.analyzedCount,
        errors: [...left.errors, ...right.errors]
      };
    }
    return { results: [], analyzedCount: 0, errors: [message] };
  }
}

function shouldSplitBatch(message) {
  return /request too large|context_length|maximum context|413/i.test(message);
}

function shouldRetryRateLimit(message) {
  return /HTTP 429|rate limit reached|try again in/i.test(message);
}

function retryDelayMs(message) {
  const seconds = Number(String(message).match(/try again in\s+([0-9.]+)s/i)?.[1] || 30);
  return Math.ceil((Number.isFinite(seconds) ? seconds : 30) * 1000) + 1000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStage1Messages(batch, departments, knocContext) {
  return [
    {
      role: "system",
      content:
        "너는 한국석유공사(KNOC)의 언론 모니터링 1차 분류 담당자다. 0차 키워드는 A/B 라우팅 참고용일 뿐이며, 최종 판단은 기사 문맥과 한국석유공사의 역할, 부서별 업무 설명을 기준으로 한다. 반드시 유효한 JSON 객체 하나만 반환한다."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task:
            "각 기사를 1차 검토하라. A 그룹은 키워드 히트 기사이므로 실제 관련성이 있는지 검토하고, B 그룹은 키워드가 없더라도 문맥상 한국석유공사와 연결될 가능성이 있는지 찾아라. 관련 가능성이 있으면 candidate=true로 두고 관련 부서를 배정하라.",
          knoc_context: compactKnocContext(knocContext),
          departments: compactDepartmentPromptInput(departments, 90),
          articles: batch.map(({ article, stage0, segments }) => ({
            id: article.id,
            publisher: article.publisher,
            title: article.title,
            url: article.url,
            published_at: article.published_at,
            stage0_group: stage0?.group || "B",
            stage0_label: stage0?.group_label || "keyword_miss",
            stage0_keyword_hits: stage0?.matched_terms || [],
            segments: segments.map((segment) => ({
              id: segment.id,
              type: segment.type,
              text: segment.text
            }))
          })),
          rules: [
            "A 그룹이라고 무조건 관련 기사로 보지 않는다. 단순 유가, 일반 경제, 정치 이슈는 KNOC 업무와 연결되는 근거가 있어야 한다.",
            "B 그룹이라도 에너지 안보, 석유/가스 수급, 비축, 해외자원개발, 공공기관 운영, 예산/감사/법무/안전/ESG/정보보안 등 KNOC 업무 영향이 있으면 candidate=true로 둔다.",
            "애매하지만 후속 검토 가치가 있으면 candidate=true, confidence는 낮게 둔다. 1차 분류는 누락 방지가 우선이다.",
            "부서 배정은 부서명보다 부서 역할 설명과 KNOC 역할을 기준으로 한다.",
            "기사 전체가 아니라 특정 문장/문단만 부서와 관련되면 evidence_type을 sentence 또는 paragraph로 둔다.",
            "evidence_text는 입력 segment에 실제로 있는 원문 일부를 사용하고, 없는 사실을 만들지 않는다."
          ],
          output_schema: {
            results: [
              {
                article_id: "article id",
                candidate: true,
                confidence: 0.76,
                company_reason: "한국석유공사 관점에서 후속 검토해야 하는 이유",
                departments: [
                  {
                    department_id: "department id",
                    relevance_score: 0.8,
                    evidence_segment_ids: ["s1"],
                    evidence_text: "입력 기사에 있는 근거 문장 또는 문단",
                    evidence_type: "sentence | paragraph | article",
                    reason: "해당 부서 업무와 연결되는 이유"
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )
    }
  ];
}

function buildStage2Messages(batch, departments, knocContext) {
  return [
    {
      role: "system",
      content:
        "너는 한국석유공사(KNOC)의 언론 모니터링 최종 분류 담당자다. 1차 판단을 참고하되 그대로 따르지 말고, 더 자세한 기사 내용과 부서별 역할을 기준으로 최종 배정한다. 반드시 유효한 JSON 객체 하나만 반환한다."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task:
            "각 기사를 2차 검토하라. C 그룹은 1차 후보 기사이므로 근거와 부서 배정을 정밀 검토하고, D 그룹은 1차 제외 기사이므로 누락 가능성을 본문 기반으로 재검토하라. 최종적으로 한국석유공사 업무와 관련 있는 기사만 final_relevant=true로 둔다.",
          knoc_context: compactKnocContext(knocContext),
          departments: compactDepartmentPromptInput(departments, 180),
          articles: batch.map(({ article, stage0, stage1, stage2Group, segments }) => ({
            id: article.id,
            publisher: article.publisher,
            title: article.title,
            url: article.url,
            published_at: article.published_at,
            stage0_group: stage0?.group || "B",
            stage0_keyword_hits: stage0?.matched_terms || [],
            stage1_group: stage2Group,
            stage1_candidate: Boolean(stage1?.candidate),
            stage1_confidence: Number(stage1?.confidence || 0),
            stage1_reason: stage1?.company_reason || "",
            stage1_departments: stage1?.departments || [],
            segments: segments.map((segment) => ({
              id: segment.id,
              type: segment.type,
              text: segment.text
            }))
          })),
          rules: [
            "최종 판단은 기사 내용, KNOC 역할, 22개 부서 업무 설명을 함께 보고 결정한다.",
            "C 그룹도 과잉 분류였다고 판단되면 final_relevant=false로 바꿀 수 있다.",
            "D 그룹도 놓친 기사라고 판단되면 final_relevant=true로 복구하고 부서를 배정한다.",
            "부서는 여러 개 배정할 수 있지만, 명확한 근거가 있는 부서만 배정한다.",
            "최종 배정 근거는 문장/문단/전체기사 단위로 구분하고 evidence_text에 원문 근거를 넣는다.",
            "한국석유공사와 직접 관련이 없더라도 석유비축, 석유수급, 해외자원개발, 에너지 안보, 공공기관 운영에 실질 영향이 있으면 관련 기사로 볼 수 있다.",
            "단순 주가, 일반 정치, 일반 국제정세, 단순 사건사고는 KNOC 업무 영향 근거가 없으면 제외한다."
          ],
          output_schema: {
            results: [
              {
                article_id: "article id",
                final_relevant: true,
                confidence: 0.88,
                final_reason: "최종적으로 포함 또는 제외한 이유",
                review_note: "1차 판단 대비 유지/수정/복구/제외 설명",
                departments: [
                  {
                    department_id: "department id",
                    relevance_score: 0.9,
                    evidence_segment_ids: ["s3"],
                    evidence_text: "입력 기사에 있는 근거 문장 또는 문단",
                    evidence_type: "sentence | paragraph | article",
                    reason: "해당 부서 업무와 연결되는 이유"
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )
    }
  ];
}

function buildStage2Inputs({ articles, stage0, stage1, reviewRejected, maxRejected }) {
  const articleMap = new Map(articles.map((article) => [article.id, article]));
  const stage0Map = new Map(stage0.items.map((item) => [item.article_id, item]));
  const rejected = [];
  const candidates = [];

  for (const result of stage1.results || []) {
    const article = articleMap.get(result.article_id);
    if (!article) continue;
    const input = {
      article,
      stage0: stage0Map.get(article.id),
      stage1: result,
      stage2Group: result.candidate ? "C" : "D",
      segments: segmentArticle(article, { maxSegments: 14, maxTextChars: 2800, maxSegmentChars: 700 })
    };
    if (result.candidate) candidates.push(input);
    else rejected.push(input);
  }

  const rejectedForReview = reviewRejected
    ? maxRejected > 0
      ? rejected.slice(0, maxRejected)
      : rejected
    : [];
  return [...candidates, ...rejectedForReview];
}

function buildBriefs({ targetDate, articles, departments, stage0, stage1, stage2, maxItemsPerDepartment, maxOverallItems }) {
  const articleMap = new Map(articles.map((article) => [article.id, article]));
  const stage0Map = new Map(stage0.items.map((item) => [item.article_id, item]));
  const stage1Map = new Map((stage1.results || []).map((result) => [result.article_id, result]));
  const departmentsOutput = createDepartmentOutputs(departments);
  const departmentMap = new Map(departmentsOutput.map((department) => [department.department_id, department]));
  const departmentNameMap = new Map(departments.map((department) => [department.id, department.name]));
  const overallItems = [];

  for (const result of stage2.results || []) {
    if (!result.final_relevant) continue;
    const article = articleMap.get(result.article_id);
    if (!article) continue;

    const commonItem = {
      id: stableId([article.id, "overall", result.final_reason]),
      article_id: article.id,
      publisher: article.publisher,
      title: article.title,
      url: article.url,
      published_at: article.published_at,
      score: result.confidence || maxDepartmentScore(result.departments),
      segment_text: result.final_reason || article.description || article.title,
      reason: result.final_reason || "",
      evidence_type: "article",
      source: "llm",
      analysis_stage: "stage2",
      stage0_group: stage0Map.get(article.id)?.group || "B",
      stage1_group: stage1Map.get(article.id)?.candidate ? "C" : "D",
      review_note: result.review_note || "",
      departments: result.departments.map((department) => ({
        id: department.department_id,
        name: departmentNameMap.get(department.department_id) || department.department_id,
        score: department.relevance_score,
        source: "llm"
      }))
    };
    overallItems.push(commonItem);

    for (const departmentResult of result.departments) {
      const department = departmentMap.get(departmentResult.department_id);
      if (!department) continue;
      department.items.push({
        id: stableId([article.id, departmentResult.department_id, departmentResult.evidence_text]),
        article_id: article.id,
        publisher: article.publisher,
        title: article.title,
        url: article.url,
        published_at: article.published_at,
        score: departmentResult.relevance_score,
        segment_text: departmentResult.evidence_text || result.final_reason || article.description || article.title,
        reason:
          departmentResult.reason ||
          `${departmentNameMap.get(departmentResult.department_id) || departmentResult.department_id} 업무와 연결됩니다.`,
        evidence_type: departmentResult.evidence_type,
        evidence_segment_ids: departmentResult.evidence_segment_ids,
        source: "llm",
        analysis_stage: "stage2",
        stage0_group: stage0Map.get(article.id)?.group || "B",
        stage1_group: stage1Map.get(article.id)?.candidate ? "C" : "D",
        review_note: result.review_note || ""
      });
    }
  }

  for (const department of departmentsOutput) {
    department.items = bestItemPerArticle(department.items).sort(sortItems).slice(0, maxItemsPerDepartment);
    department.article_count = new Set(department.items.map((item) => item.article_id)).size;
    department.segment_count = department.items.length;
  }

  const overall = {
    id: "overall",
    label: "전체",
    source: "llm",
    article_count: new Set(overallItems.map((item) => item.article_id)).size,
    item_count: overallItems.length,
    items: bestItemPerArticle(overallItems).sort(sortItems).slice(0, maxOverallItems)
  };

  const relevantArticleIds = new Set(overall.items.map((item) => item.article_id));
  const relevantDepartmentCount = departmentsOutput.filter((department) => department.article_count > 0).length;

  return {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: analyzerVersion,
    input_article_count: articles.length,
    relevant_article_count: relevantArticleIds.size,
    relevant_department_count: relevantDepartmentCount,
    pipeline: {
      stage0: {
        analyzer: stage0.analyzer,
        keyword_hit_count: stage0.keyword_hit_count,
        keyword_miss_count: stage0.keyword_miss_count
      },
      stage1: summarizeStage(stage1),
      stage2: summarizeStage(stage2)
    },
    overall,
    llm_review: {
      enabled: Boolean(stage1.enabled || stage2.enabled),
      status: finalLlmStatus(stage1, stage2),
      provider: stage2.provider || stage1.provider || null,
      model: stage2.model || stage1.model || null,
      analyzed_article_count: stage2.analyzed_article_count || 0,
      stages: {
        stage1: summarizeStage(stage1),
        stage2: summarizeStage(stage2)
      }
    },
    departments: departmentsOutput
  };
}

function createStageClient(stageName, defaults) {
  const provider =
    process.env[`${stageName}_PROVIDER`] ||
    process.env[`${stageName}_LLM_PROVIDER`] ||
    defaults.provider ||
    "none";
  const requestedModel =
    process.env[`${stageName}_MODEL`] ||
    process.env[`${stageName}_LLM_MODEL`] ||
    defaults.model ||
    process.env.LLM_MODEL;
  const model = selectSafeStageModel({ stageName, provider, requestedModel });
  const env = {
    ...process.env,
    LLM_PROVIDER: provider,
    LLM_MODEL: model
  };

  try {
    return {
      provider,
      model,
      client: createLlmClient(env),
      setup_error: null
    };
  } catch (error) {
    return {
      provider,
      model,
      client: null,
      setup_error: messageOf(error)
    };
  }
}

function selectSafeStageModel({ stageName, provider, requestedModel }) {
  const model = String(requestedModel || "");
  const lowTpmStage1 =
    stageName === "STAGE1" &&
    normalizeProviderName(provider) === "groq" &&
    model === "llama-3.1-8b-instant";
  if (lowTpmStage1 && !booleanEnv(process.env.STAGE1_ALLOW_LOW_TPM, false)) {
    return process.env.STAGE1_SAFE_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
  }
  return model;
}

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function disabledStage({ targetDate, stage, setup, requestedArticleCount }) {
  return {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: `${stage}-llm`,
    enabled: false,
    provider: setup.provider || null,
    model: setup.model || null,
    status: setup.setup_error ? "setup-error" : "disabled",
    requested_article_count: requestedArticleCount,
    analyzed_article_count: 0,
    batch_size: 0,
    errors: setup.setup_error ? [setup.setup_error] : [],
    results: []
  };
}

function createReview({ targetDate, stage, client, requestedArticleCount, batchSize }) {
  return {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: `${stage}-llm`,
    enabled: true,
    provider: client.provider,
    model: client.model,
    status: "ok",
    requested_article_count: requestedArticleCount,
    analyzed_article_count: 0,
    batch_size: batchSize,
    errors: [],
    warnings: [],
    results: []
  };
}

function finalizeStage1(review) {
  review.candidate_count = (review.results || []).filter((result) => result.candidate).length;
  review.rejected_count = (review.results || []).filter((result) => !result.candidate).length;
  return review;
}

function finalizeStage2(review) {
  review.final_relevant_count = (review.results || []).filter((result) => result.final_relevant).length;
  review.final_rejected_count = (review.results || []).filter((result) => !result.final_relevant).length;
  return review;
}

function summarizeStage(stage) {
  return {
    enabled: Boolean(stage.enabled),
    status: stage.status,
    provider: stage.provider || null,
    model: stage.model || null,
    requested_article_count: stage.requested_article_count || 0,
    analyzed_article_count: stage.analyzed_article_count || 0,
    candidate_count: stage.candidate_count,
    rejected_count: stage.rejected_count,
    final_relevant_count: stage.final_relevant_count,
    final_rejected_count: stage.final_rejected_count,
    warning_count: stage.warnings?.length || 0,
    error_count: stage.errors?.length || 0
  };
}

function finalLlmStatus(stage1, stage2) {
  if (stage2.enabled) return stage2.status;
  if (stage1.enabled) return stage1.status;
  return stage1.status || stage2.status || "disabled";
}

function normalizeStage1Result(result, batch, departments) {
  const articleIds = new Set(batch.map(({ article }) => article.id));
  const departmentIds = new Set(departments.map((department) => department.id));
  const articleId = String(result?.article_id || "");
  if (!articleIds.has(articleId)) return null;

  return {
    article_id: articleId,
    candidate: Boolean(result.candidate ?? result.company_relevant),
    confidence: clamp(Number(result.confidence ?? result.relevance_score ?? 0), 0, 1),
    company_reason: cleanText(result.company_reason || result.reason || ""),
    departments: normalizeDepartments(result.departments, departmentIds)
  };
}

function normalizeStage2Result(result, batch, departments) {
  const articleIds = new Set(batch.map(({ article }) => article.id));
  const departmentIds = new Set(departments.map((department) => department.id));
  const articleId = String(result?.article_id || "");
  if (!articleIds.has(articleId)) return null;

  return {
    article_id: articleId,
    final_relevant: Boolean(result.final_relevant ?? result.company_relevant),
    confidence: clamp(Number(result.confidence ?? result.relevance_score ?? 0), 0, 1),
    final_reason: cleanText(result.final_reason || result.company_reason || result.reason || ""),
    review_note: cleanText(result.review_note || ""),
    departments: normalizeDepartments(result.departments, departmentIds)
  };
}

function normalizeDepartments(departments, departmentIds) {
  if (!Array.isArray(departments)) return [];
  return departments
    .map((department) => ({
      department_id: String(department.department_id || ""),
      relevance_score: clamp(Number(department.relevance_score ?? department.score ?? 0), 0, 1),
      evidence_segment_ids: Array.isArray(department.evidence_segment_ids)
        ? department.evidence_segment_ids.map(String).slice(0, 8)
        : [],
      evidence_text: cleanText(department.evidence_text || ""),
      evidence_type: ["sentence", "paragraph", "article"].includes(department.evidence_type)
        ? department.evidence_type
        : "article",
      reason: cleanText(department.reason || "")
    }))
    .filter((department) => departmentIds.has(department.department_id));
}

function departmentPromptInput(departments) {
  return departments.map((department) => ({
    id: department.id,
    name: department.name,
    role: department.role
  }));
}

function compactKnocContext(knocContext) {
  return {
    name: knocContext.name,
    aliases: Array.isArray(knocContext.aliases) ? knocContext.aliases.slice(0, 5) : [],
    role: clipText(knocContext.role || "", 420),
    classification_policy: Array.isArray(knocContext.classification_policy)
      ? knocContext.classification_policy.map((item) => clipText(item, 160)).slice(0, 6)
      : []
  };
}

function compactDepartmentPromptInput(departments, roleLength) {
  return departments.map((department) => ({
    id: department.id,
    name: department.name,
    role: clipText(department.role, roleLength)
  }));
}

function normalizeKeywordEntries(keywordConfig) {
  const entries = Array.isArray(keywordConfig.keywords) ? keywordConfig.keywords : [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return { term: entry, category: "general", normalized: normalizeSearchText(entry) };
      }
      return {
        term: String(entry.term || ""),
        category: String(entry.category || "general"),
        normalized: normalizeSearchText(entry.term || "")
      };
    })
    .filter((entry) => entry.term && entry.normalized);
}

function matchStage0Keywords(article, keywordEntries) {
  const text = normalizeSearchText(
    [article.title, article.description, article.body_text, article.publisher].filter(Boolean).join(" ")
  );
  const matches = [];
  for (const entry of keywordEntries) {
    if (text.includes(entry.normalized)) matches.push({ term: entry.term, category: entry.category });
  }
  return matches;
}

function createDepartmentOutputs(departments) {
  return departments.map((department) => ({
    department_id: department.id,
    department: department.name,
    role: department.role,
    article_count: 0,
    segment_count: 0,
    items: []
  }));
}

function segmentArticle(article, { maxSegments, maxTextChars, maxSegmentChars = 900 }) {
  const segments = [];
  if (article.title) segments.push({ type: "title", text: cleanText(article.title) });
  if (article.description) {
    for (const sentence of splitSentences(article.description)) {
      segments.push({ type: "summary_sentence", text: sentence });
    }
  }
  if (article.body_text) {
    for (const paragraph of String(article.body_text).split(/\n{2,}/)) {
      const text = cleanText(paragraph);
      if (text.length >= 30) segments.push({ type: "body_paragraph", text });
    }
  }

  const clipped = [];
  let usedChars = 0;
  for (const segment of segments.filter((item) => item.text.length >= 6)) {
    if (clipped.length >= maxSegments || usedChars >= maxTextChars) break;
    const remaining = maxTextChars - usedChars;
    const text = clipText(segment.text, Math.min(maxSegmentChars, remaining));
    if (!text) continue;
    clipped.push({
      ...segment,
      id: `s${clipped.length + 1}`,
      text
    });
    usedChars += text.length;
  }
  return clipped;
}

function splitSentences(text) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const pieces = normalized.match(/[^.!?。！？]+[.!?。！？]?/g) || [normalized];
  return pieces.map(cleanText).filter(Boolean);
}

async function updateIndex(targetDate, briefs) {
  const indexPath = path.join(dataDir, "index.json");
  let index = { runs: [] };
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {
    index = { runs: [] };
  }

  const runs = (index.runs || []).filter((run) => run.target_date !== targetDate);
  let existingRun = {};
  try {
    existingRun = JSON.parse(await fs.readFile(path.join(dataDir, targetDate, "run.json"), "utf8"));
  } catch {
    existingRun = {};
  }

  runs.unshift({
    target_date: targetDate,
    collected_at: existingRun.collected_at || briefs.generated_at,
    article_count: existingRun.article_count ?? briefs.input_article_count,
    include_body: Boolean(existingRun.include_body),
    path: `data/${targetDate}/articles.json`,
    brief_path: `data/${targetDate}/briefs.json`,
    relevant_article_count: briefs.relevant_article_count,
    relevant_department_count: briefs.relevant_department_count,
    analyzed_at: briefs.generated_at,
    analyzer: briefs.analyzer
  });

  runs.sort((a, b) => String(b.target_date).localeCompare(String(a.target_date)));
  await writeJson(indexPath, { runs });
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") args.date = argv[++index];
    else if (arg === "--max-items-per-department") args.maxItemsPerDepartment = argv[++index];
    else if (arg === "--max-overall-items") args.maxOverallItems = argv[++index];
    else if (arg === "--stage1-max-articles") args.stage1MaxArticles = argv[++index];
    else if (arg === "--stage2-max-articles") args.stage2MaxArticles = argv[++index];
    else if (arg === "--stage1-batch-size") args.stage1BatchSize = argv[++index];
    else if (arg === "--stage2-batch-size") args.stage2BatchSize = argv[++index];
    else if (arg === "--stage2-max-rejected") args.stage2MaxRejected = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/analyze.mjs --date YYYY-MM-DD [--stage1-batch-size 8] [--stage2-batch-size 4]"
      );
      process.exit(0);
    }
  }
  return args;
}

function resolveTargetDate(input) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const now = new Date();
  if (input === "today") return dateInKst(now);
  if (input === "yesterday") {
    const today = new Date(`${dateInKst(now)}T00:00:00+09:00`);
    today.setUTCDate(today.getUTCDate() - 1);
    return dateInKst(today);
  }
  throw new Error(`Invalid date: ${input}`);
}

function dateInKst(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function bestItemPerArticle(items) {
  const map = new Map();
  for (const item of items) {
    const existing = map.get(item.article_id);
    if (!existing || item.score > existing.score || item.segment_text.length > existing.segment_text.length) {
      map.set(item.article_id, item);
    }
  }
  return [...map.values()];
}

function sortItems(a, b) {
  const scoreOrder = Number(b.score || 0) - Number(a.score || 0);
  if (scoreOrder !== 0) return scoreOrder;
  return String(b.published_at || "").localeCompare(String(a.published_at || ""));
}

function maxDepartmentScore(departments) {
  if (!departments?.length) return 0.5;
  return Math.max(...departments.map((department) => Number(department.relevance_score || 0.5)));
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(value) {
  return cleanText(value).normalize("NFKC").toLowerCase();
}

function clipText(value, maxLength) {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function stableId(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 16);
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function booleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
