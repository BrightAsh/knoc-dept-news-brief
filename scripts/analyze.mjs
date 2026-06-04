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
const analyzerVersion = "llm-department-context-v1";
const timeZone = "Asia/Seoul";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDate = resolveTargetDate(args.date || "yesterday");
  const maxItemsPerDepartment = Number(args.maxItemsPerDepartment || 80);
  const maxOverallItems = Number(args.maxOverallItems || 200);
  const llmMaxArticles = Number(args.llmMaxArticles ?? process.env.LLM_MAX_ARTICLES ?? 0);
  const llmBatchSize = Number(args.llmBatchSize || process.env.LLM_BATCH_SIZE || 5);

  const dayDir = path.join(dataDir, targetDate);
  const articles = JSON.parse(await fs.readFile(path.join(dayDir, "articles.json"), "utf8"));
  const departments = JSON.parse(await fs.readFile(departmentsPath, "utf8"));
  const knocContext = JSON.parse(await fs.readFile(knocContextPath, "utf8"));
  const departmentsOutput = createDepartmentOutputs(departments);

  let llmClient = null;
  let setupError = null;
  try {
    llmClient = createLlmClient();
  } catch (error) {
    setupError = messageOf(error);
  }

  const llmReview = llmClient
    ? await runLlmClassification({
        client: llmClient,
        articles,
        departments,
        knocContext,
        maxArticles: llmMaxArticles,
        batchSize: llmBatchSize
      })
    : {
        enabled: false,
        provider: process.env.LLM_PROVIDER || "not-configured",
        model: process.env.LLM_MODEL || null,
        status: setupError ? "setup-error" : "disabled",
        requested_article_count: 0,
        analyzed_article_count: 0,
        relevant_article_count: 0,
        errors: setupError ? [setupError] : [],
        results: [],
        message: setupError
          ? "LLM 설정 오류가 있어 분류하지 않았습니다."
          : "LLM provider가 설정되지 않아 분류하지 않았습니다."
      };

  const articleMap = new Map(articles.map((article) => [article.id, article]));
  mergeLlmResults({
    departmentsOutput,
    llmReview,
    articleMap,
    departments,
    maxItemsPerDepartment
  });

  const overall = buildOverall({
    llmReview,
    articleMap,
    departmentsOutput,
    maxOverallItems
  });

  const relevantArticleIds = new Set(overall.items.map((item) => item.article_id));
  const relevantDepartmentCount = departmentsOutput.filter((department) => department.article_count > 0).length;
  const briefs = {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: analyzerVersion,
    input_article_count: articles.length,
    relevant_article_count: relevantArticleIds.size,
    relevant_department_count: relevantDepartmentCount,
    overall,
    llm_review: {
      ...llmReview,
      results: undefined
    },
    departments: departmentsOutput
  };

  await fs.writeFile(path.join(dayDir, "briefs.json"), `${JSON.stringify(briefs, null, 2)}\n`, "utf8");
  await updateIndex(targetDate, briefs);

  console.log(
    JSON.stringify(
      {
        target_date: targetDate,
        analyzer: analyzerVersion,
        input_article_count: articles.length,
        relevant_article_count: briefs.relevant_article_count,
        relevant_department_count: briefs.relevant_department_count,
        llm_status: llmReview.status,
        llm_provider: llmReview.provider,
        llm_model: llmReview.model,
        output: `data/${targetDate}/briefs.json`
      },
      null,
      2
    )
  );
}

async function runLlmClassification({ client, articles, departments, knocContext, maxArticles, batchSize }) {
  const articleInputs = articles.map((article) => ({
    article,
    segments: segmentArticle(article)
  }));
  const selected = maxArticles > 0 ? articleInputs.slice(0, maxArticles) : articleInputs;
  const review = {
    enabled: true,
    provider: client.provider,
    model: client.model,
    status: "ok",
    requested_article_count: selected.length,
    analyzed_article_count: 0,
    relevant_article_count: 0,
    batch_size: batchSize,
    errors: [],
    results: []
  };

  if (!selected.length) {
    review.status = "empty";
    return review;
  }

  for (const batch of chunk(selected, Math.max(1, batchSize))) {
    try {
      const payload = await client.chatJson(buildLlmMessages(batch, departments, knocContext), {
        maxTokens: 3600,
        temperature: 0.1
      });
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const result of results) {
        const normalized = normalizeLlmResult(result, batch, departments);
        if (normalized) review.results.push(normalized);
      }
      review.analyzed_article_count += batch.length;
    } catch (error) {
      review.status = review.results.length ? "partial" : "error";
      review.errors.push(messageOf(error));
    }
  }

  review.relevant_article_count = review.results.filter((result) => result.company_relevant).length;
  if (review.status === "ok" && review.analyzed_article_count < selected.length) review.status = "partial";
  return review;
}

function buildLlmMessages(batch, departments, knocContext) {
  const departmentInput = departments.map((department) => ({
    id: department.id,
    name: department.name,
    role: department.role
  }));
  const articleInput = batch.map(({ article, segments }) => ({
    id: article.id,
    publisher: article.publisher,
    title: article.title,
    url: article.url,
    published_at: article.published_at,
    segments: segments.map((segment) => ({
      id: segment.id,
      type: segment.type,
      text: segment.text
    }))
  }));

  return [
    {
      role: "system",
      content:
        "너는 한국석유공사(KNOC) 언론 모니터링 분류 전문가다. 키워드 매칭이 아니라 한국석유공사의 역할, 각 부서의 담당 업무, 기사 문맥을 종합해 판단한다. 응답은 반드시 유효한 JSON 객체 하나만 반환한다."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task:
            "각 기사에 대해 한국석유공사 관점의 관련성 여부와 관련 부서를 분류하라. 기사 전체가 아니라 특정 문장/문단만 부서와 관련될 수 있으므로, 관련 근거 segment id와 원문 근거를 반드시 반환하라.",
          knoc_context: knocContext,
          departments: departmentInput,
          articles: articleInput,
          rules: [
            "한국석유공사와 실질적 관련성이 없으면 company_relevant=false, departments=[]로 둔다.",
            "부서 배정은 부서명보다 role 설명을 우선하여 판단한다.",
            "한 기사에 여러 부서가 관련될 수 있다.",
            "특정 문장/문단만 관련되면 evidence_type을 sentence 또는 paragraph로 둔다.",
            "기사 전체 주제가 관련되면 evidence_type을 article로 둘 수 있다.",
            "입력에 없는 내용을 만들어내지 말고, evidence_text는 입력 segment의 원문을 사용한다."
          ],
          output_schema: {
            results: [
              {
                article_id: "article id",
                company_relevant: true,
                company_reason: "한국석유공사 관점에서 모니터링해야 하는 이유",
                departments: [
                  {
                    department_id: "department id",
                    relevance_score: 0.85,
                    evidence_segment_ids: ["segment id"],
                    evidence_text: "근거가 되는 입력 원문 문장 또는 문단",
                    evidence_type: "sentence | paragraph | article",
                    reason: "해당 부서 담당 업무와 연결되는 이유"
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

function mergeLlmResults({ departmentsOutput, llmReview, articleMap, departments, maxItemsPerDepartment }) {
  const departmentMap = new Map(departmentsOutput.map((department) => [department.department_id, department]));
  const departmentNameMap = new Map(departments.map((department) => [department.id, department.name]));

  for (const result of llmReview.results || []) {
    if (!result.company_relevant) continue;
    const article = articleMap.get(result.article_id);
    if (!article) continue;

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
        segment_text: departmentResult.evidence_text || result.company_reason || article.description || article.title,
        reason:
          departmentResult.reason ||
          `${departmentNameMap.get(departmentResult.department_id) || departmentResult.department_id} 업무와 문맥상 연결됩니다.`,
        evidence_type: departmentResult.evidence_type,
        evidence_segment_ids: departmentResult.evidence_segment_ids,
        source: "llm"
      });
    }
  }

  for (const department of departmentsOutput) {
    department.items = bestItemPerArticle(department.items)
      .sort(sortItems)
      .slice(0, maxItemsPerDepartment);
    department.article_count = new Set(department.items.map((item) => item.article_id)).size;
    department.segment_count = department.items.length;
  }
}

function buildOverall({ llmReview, articleMap, departmentsOutput, maxOverallItems }) {
  const departmentsByArticle = new Map();
  for (const department of departmentsOutput) {
    for (const item of department.items) {
      if (!departmentsByArticle.has(item.article_id)) departmentsByArticle.set(item.article_id, []);
      departmentsByArticle.get(item.article_id).push({
        id: department.department_id,
        name: department.department,
        score: item.score,
        source: "llm"
      });
    }
  }

  const items = (llmReview.results || [])
    .filter((result) => result.company_relevant)
    .map((result) => {
      const article = articleMap.get(result.article_id);
      if (!article) return null;
      return {
        id: stableId([article.id, "overall", "llm"]),
        article_id: article.id,
        publisher: article.publisher,
        title: article.title,
        url: article.url,
        published_at: article.published_at,
        score: maxDepartmentScore(result.departments),
        segment_text: result.company_reason || article.description || article.title,
        reason: result.company_reason || "LLM이 한국석유공사 업무 관련 기사로 분류했습니다.",
        evidence_type: "article",
        departments: departmentsByArticle.get(article.id) || [],
        source: "llm"
      };
    })
    .filter(Boolean)
    .sort(sortItems)
    .slice(0, maxOverallItems);

  return {
    id: "overall",
    label: "전체",
    source: "llm",
    article_count: new Set(items.map((item) => item.article_id)).size,
    item_count: items.length,
    items
  };
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

function segmentArticle(article) {
  const segments = [];
  if (article.title) segments.push({ type: "title", text: cleanText(article.title) });
  if (article.description) {
    const descriptionSegments = splitSentences(article.description);
    for (const sentence of descriptionSegments.length ? descriptionSegments : [cleanText(article.description)]) {
      segments.push({ type: "summary_sentence", text: sentence });
    }
  }
  if (article.body_text) {
    for (const paragraph of String(article.body_text).split(/\n{2,}/)) {
      const text = cleanText(paragraph);
      if (text.length >= 30) segments.push({ type: "body_paragraph", text });
    }
  }

  return segments
    .filter((segment) => segment.text.length >= 6)
    .slice(0, 35)
    .map((segment, index) => ({
      ...segment,
      id: `s${index + 1}`
    }));
}

function normalizeLlmResult(result, batch, departments) {
  const articleIds = new Set(batch.map(({ article }) => article.id));
  const departmentIds = new Set(departments.map((department) => department.id));
  const articleId = String(result?.article_id || "");
  if (!articleIds.has(articleId)) return null;

  return {
    article_id: articleId,
    company_relevant: Boolean(result.company_relevant),
    company_reason: cleanText(result.company_reason || ""),
    departments: Array.isArray(result.departments)
      ? result.departments
          .map((department) => ({
            department_id: String(department.department_id || ""),
            relevance_score: clamp(Number(department.relevance_score ?? department.score ?? 0), 0, 1),
            evidence_segment_ids: Array.isArray(department.evidence_segment_ids)
              ? department.evidence_segment_ids.map(String).slice(0, 6)
              : [],
            evidence_text: cleanText(department.evidence_text || ""),
            evidence_type: ["sentence", "paragraph", "article"].includes(department.evidence_type)
              ? department.evidence_type
              : "article",
            reason: cleanText(department.reason || "")
          }))
          .filter((department) => departmentIds.has(department.department_id))
      : []
  };
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

function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|(?<=다\.)\s+|(?<=요\.)\s+/u)
    .map(cleanText)
    .filter(Boolean);
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
  await fs.writeFile(path.join(dataDir, "index.json"), `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") args.date = argv[++index];
    else if (arg === "--max-items-per-department") args.maxItemsPerDepartment = argv[++index];
    else if (arg === "--max-overall-items") args.maxOverallItems = argv[++index];
    else if (arg === "--llm-max-articles") args.llmMaxArticles = argv[++index];
    else if (arg === "--llm-batch-size") args.llmBatchSize = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/analyze.mjs --date YYYY-MM-DD [--llm-max-articles 0] [--llm-batch-size 5]"
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

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
