import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLlmClient } from "./llm-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const departmentsPath = path.join(rootDir, "config", "departments.json");
const analyzerVersion = "rule-keyword-v1";
const timeZone = "Asia/Seoul";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDate = resolveTargetDate(args.date || "yesterday");
  const maxItemsPerDepartment = Number(args.maxItemsPerDepartment || 40);
  const maxOverallItems = Number(args.maxOverallItems || 120);
  const minScore = Number(args.minScore || 2);
  const llmMaxArticles = Number(args.llmMaxArticles || process.env.LLM_MAX_ARTICLES || 80);
  const llmBatchSize = Number(args.llmBatchSize || process.env.LLM_BATCH_SIZE || 8);

  const dayDir = path.join(dataDir, targetDate);
  const articlesPath = path.join(dayDir, "articles.json");
  const articles = JSON.parse(await fs.readFile(articlesPath, "utf8"));
  const departments = JSON.parse(await fs.readFile(departmentsPath, "utf8")).map(normalizeDepartment);

  const ruleResult = analyzeWithRules(articles, departments, {
    minScore,
    maxItemsPerDepartment
  });

  let llmClient = null;
  let llmSetupError = null;
  try {
    llmClient = createLlmClient();
  } catch (error) {
    llmSetupError = messageOf(error);
  }
  const llmReview = llmClient
    ? await runLlmReview({
        client: llmClient,
        articles,
        departments,
        ruleItems: ruleResult.allItems,
        maxArticles: llmMaxArticles,
        batchSize: llmBatchSize
      })
    : {
        enabled: false,
        provider: "rule",
        model: null,
        status: llmSetupError ? "setup-error" : "disabled",
        analyzed_article_count: 0,
        relevant_article_count: 0,
        errors: llmSetupError ? [llmSetupError] : [],
        message: llmSetupError
          ? "LLM 설정 오류가 있어 규칙 기반 분석만 수행했습니다."
          : "LLM_PROVIDER가 rule/none/off 이거나 설정되지 않아 규칙 기반 분석만 수행했습니다."
      };

  mergeLlmReviewIntoDepartments(ruleResult.departmentsOutput, llmReview, articles, departments, maxItemsPerDepartment);

  const overall = buildOverall({
    articles,
    departmentsOutput: ruleResult.departmentsOutput,
    ruleItems: ruleResult.allItems,
    llmReview,
    maxOverallItems
  });

  const relevantArticleIds = new Set();
  for (const item of overall.items || []) relevantArticleIds.add(item.article_id);
  for (const department of ruleResult.departmentsOutput) {
    for (const item of department.items || []) relevantArticleIds.add(item.article_id);
  }

  const relevantDepartmentCount = ruleResult.departmentsOutput.filter((department) => department.article_count > 0).length;
  const relevantArticleCount = relevantArticleIds.size || ruleResult.relevantArticleCount;
  const briefs = {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: llmReview.enabled ? `${analyzerVersion}+${llmReview.provider}` : analyzerVersion,
    input_article_count: articles.length,
    relevant_article_count: relevantArticleCount,
    relevant_department_count: relevantDepartmentCount,
    overall,
    llm_review: llmReview,
    departments: ruleResult.departmentsOutput
  };

  await fs.writeFile(path.join(dayDir, "briefs.json"), `${JSON.stringify(briefs, null, 2)}\n`, "utf8");
  await updateIndex(targetDate, briefs);

  console.log(
    JSON.stringify(
      {
        target_date: targetDate,
        analyzer: briefs.analyzer,
        input_article_count: articles.length,
        relevant_article_count: relevantArticleCount,
        relevant_department_count: relevantDepartmentCount,
        llm_status: llmReview.status,
        output: `data/${targetDate}/briefs.json`
      },
      null,
      2
    )
  );
}

function analyzeWithRules(articles, departments, options) {
  const departmentMap = new Map(
    departments.map((department) => [
      department.id,
      {
        department_id: department.id,
        department: department.name,
        role: department.role,
        article_count: 0,
        segment_count: 0,
        top_keywords: [],
        items: []
      }
    ])
  );
  const articleIdsByDepartment = new Map(departments.map((department) => [department.id, new Set()]));
  const keywordCountsByDepartment = new Map(departments.map((department) => [department.id, new Map()]));
  const allItems = [];

  for (const article of articles) {
    const segments = segmentArticle(article);
    const articleDepartmentCandidates = new Set();

    for (const segment of segments) {
      const matches = matchSegment(segment, article, departments, options.minScore);
      for (const match of matches) {
        const brief = departmentMap.get(match.department_id);
        const articleIds = articleIdsByDepartment.get(match.department_id);
        const keywordCounts = keywordCountsByDepartment.get(match.department_id);
        articleIds.add(article.id);
        brief.segment_count += 1;
        articleDepartmentCandidates.add(match.department_id);

        for (const keyword of match.matched_keywords) {
          keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
        }

        const item = {
          id: stableId([article.id, segment.id, match.department_id]),
          article_id: article.id,
          publisher: article.publisher,
          title: article.title,
          url: article.url,
          published_at: article.published_at,
          score: match.score,
          matched_keywords: match.matched_keywords,
          segment_text: segment.text,
          reason: `${match.matched_keywords.join(", ")} 키워드가 ${match.department} 업무와 연결됩니다.`,
          evidence_type: match.score >= 5 ? "direct" : "watch",
          source: "rule"
        };
        brief.items.push(item);
        allItems.push({ ...item, department_id: match.department_id, department: match.department });
      }
    }

    article.department_candidates = [...articleDepartmentCandidates];
  }

  const departmentsOutput = [...departmentMap.values()].map((brief) => {
    const articleIds = articleIdsByDepartment.get(brief.department_id);
    const keywordCounts = keywordCountsByDepartment.get(brief.department_id);
    brief.article_count = articleIds.size;
    brief.top_keywords = [...keywordCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
      .slice(0, 8)
      .map(([keyword, count]) => ({ keyword, count }));
    brief.items = bestItemPerArticle(brief.items)
      .sort(sortBriefItems)
      .slice(0, options.maxItemsPerDepartment);
    return brief;
  });

  const relevantArticleCount = new Set(allItems.map((item) => item.article_id)).size;
  return { departmentsOutput, allItems, relevantArticleCount };
}

async function runLlmReview({ client, articles, departments, ruleItems, maxArticles, batchSize }) {
  const candidates = selectLlmCandidates(articles, ruleItems, maxArticles);
  const review = {
    enabled: true,
    provider: client.provider,
    model: client.model,
    status: "ok",
    requested_article_count: candidates.length,
    analyzed_article_count: 0,
    relevant_article_count: 0,
    batch_size: batchSize,
    results: [],
    errors: []
  };

  if (!candidates.length) {
    review.status = "empty";
    return review;
  }

  const batches = chunk(candidates, Math.max(1, batchSize));
  for (const batch of batches) {
    try {
      const payload = await client.chatJson(buildLlmMessages(batch, departments), { maxTokens: 2600 });
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const result of results) {
        if (!result?.article_id) continue;
        review.results.push(normalizeLlmResult(result));
      }
      review.analyzed_article_count += batch.length;
    } catch (error) {
      review.status = "partial";
      review.errors.push(messageOf(error));
    }
  }

  review.relevant_article_count = review.results.filter((result) => result.company_relevant).length;
  if (!review.results.length && review.errors.length) review.status = "error";
  return review;
}

function buildLlmMessages(articles, departments) {
  const departmentInput = departments.map((department) => ({
    id: department.id,
    name: department.name,
    role: department.role,
    keywords: department.keywords.slice(0, 10)
  }));
  const articleInput = articles.map((article) => ({
    id: article.id,
    publisher: article.publisher,
    title: article.title,
    description: article.description || "",
    body_excerpt: bodyExcerpt(article.body_text || ""),
    published_at: article.published_at
  }));

  return [
    {
      role: "system",
      content:
        "너는 한국석유공사 부서별 언론 모니터링 분석가다. 기사 제목, 요약, 본문 일부를 보고 한국석유공사 업무와 관련 있는 기사만 골라라. 관련 있으면 어떤 부서에 필요한지와 근거 문장/문단을 반환한다. 반드시 JSON만 반환한다."
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task:
            "각 article에 대해 company_relevant(boolean), company_reason(string), departments(array)를 판정하라. departments에는 department_id, score(0~1), evidence_text, evidence_type(sentence|paragraph|article), reason을 넣어라. 확실하지 않으면 departments를 비워라.",
          departments: departmentInput,
          articles: articleInput,
          output_schema: {
            results: [
              {
                article_id: "article id",
                company_relevant: true,
                company_reason: "한국석유공사 관점에서 왜 봐야 하는지",
                departments: [
                  {
                    department_id: "department id",
                    score: 0.85,
                    evidence_text: "기사에서 직접 근거가 되는 문장 또는 문단",
                    evidence_type: "sentence",
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

function selectLlmCandidates(articles, ruleItems, maxArticles) {
  const scoreByArticle = new Map();
  for (const item of ruleItems) {
    scoreByArticle.set(item.article_id, Math.max(scoreByArticle.get(item.article_id) || 0, Number(item.score || 0)));
  }

  for (const article of articles) {
    const score = companyContextScore(article);
    if (score > 0) scoreByArticle.set(article.id, Math.max(scoreByArticle.get(article.id) || 0, score));
  }

  return articles
    .filter((article) => scoreByArticle.has(article.id))
    .sort((a, b) => {
      const scoreOrder = (scoreByArticle.get(b.id) || 0) - (scoreByArticle.get(a.id) || 0);
      if (scoreOrder !== 0) return scoreOrder;
      return String(b.published_at || "").localeCompare(String(a.published_at || ""));
    })
    .slice(0, Math.max(0, maxArticles));
}

function companyContextScore(article) {
  const text = normalizeText(`${article.title || ""} ${article.description || ""} ${article.body_text || ""}`);
  const terms = [
    "한국석유공사",
    "석유공사",
    "knoc",
    "석유",
    "원유",
    "유가",
    "lpg",
    "lng",
    "에너지안보",
    "비축",
    "알뜰주유소",
    "자원개발",
    "대륙붕",
    "ccs",
    "수소",
    "암모니아",
    "해상풍력",
    "중대재해",
    "공공기관",
    "국정감사"
  ];
  return terms.reduce((sum, term) => sum + countIncludes(text, normalizeText(term)), 0);
}

function mergeLlmReviewIntoDepartments(departmentsOutput, llmReview, articles, departments, maxItemsPerDepartment) {
  if (!llmReview?.results?.length) return;

  const articleMap = new Map(articles.map((article) => [article.id, article]));
  const departmentNameMap = new Map(departments.map((department) => [department.id, department.name]));
  const departmentMap = new Map(departmentsOutput.map((department) => [department.department_id, department]));

  for (const result of llmReview.results) {
    if (!result.company_relevant) continue;
    const article = articleMap.get(result.article_id);
    if (!article) continue;

    for (const departmentResult of result.departments || []) {
      const brief = departmentMap.get(departmentResult.department_id);
      if (!brief) continue;

      brief.items.push({
        id: stableId([article.id, departmentResult.department_id, "llm"]),
        article_id: article.id,
        publisher: article.publisher,
        title: article.title,
        url: article.url,
        published_at: article.published_at,
        score: Number((Number(departmentResult.score || 0.6) * 10).toFixed(2)),
        matched_keywords: ["LLM"],
        segment_text: departmentResult.evidence_text || result.company_reason || article.description || article.title,
        reason: departmentResult.reason || `${departmentNameMap.get(departmentResult.department_id)} 업무와 문맥상 연결됩니다.`,
        evidence_type: departmentResult.evidence_type || "article",
        source: "llm"
      });
    }
  }

  for (const brief of departmentsOutput) {
    const previousArticleCount = Number(brief.article_count || 0);
    brief.items = bestItemPerArticle(brief.items)
      .sort(sortBriefItems)
      .slice(0, maxItemsPerDepartment);
    brief.article_count = Math.max(previousArticleCount, new Set(brief.items.map((item) => item.article_id)).size);
    brief.segment_count = Math.max(brief.segment_count || 0, brief.items.length);
  }
}

function buildOverall({ articles, departmentsOutput, ruleItems, llmReview, maxOverallItems }) {
  const articleMap = new Map(articles.map((article) => [article.id, article]));
  const departmentsByArticle = new Map();

  for (const department of departmentsOutput) {
    for (const item of department.items || []) {
      if (!departmentsByArticle.has(item.article_id)) departmentsByArticle.set(item.article_id, []);
      departmentsByArticle.get(item.article_id).push({
        id: department.department_id,
        name: department.department,
        score: item.score,
        source: item.source || "rule"
      });
    }
  }

  let source = "rule";
  let items = [];
  if (llmReview?.results?.some((result) => result.company_relevant)) {
    source = "llm";
    items = llmReview.results
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
      .filter(Boolean);
  } else {
    const best = bestItemPerArticle(ruleItems).filter((item) => {
      const article = articleMap.get(item.article_id);
      return article ? isRuleOverallCandidate(article, item) : false;
    });
    items = best.map((item) => ({
      id: stableId([item.article_id, "overall", "rule"]),
      article_id: item.article_id,
      publisher: item.publisher,
      title: item.title,
      url: item.url,
      published_at: item.published_at,
      score: item.score,
      segment_text: item.segment_text,
      reason: item.reason,
      evidence_type: item.evidence_type,
      departments: departmentsByArticle.get(item.article_id) || [],
      source: "rule"
    }));
  }

  items = items.sort(sortBriefItems).slice(0, maxOverallItems);

  return {
    id: "overall",
    label: "전체",
    source,
    article_count: new Set(items.map((item) => item.article_id)).size,
    item_count: items.length,
    items
  };
}

function isRuleOverallCandidate(article, item) {
  if (companyContextScore(article) > 0) return true;
  if (["she", "infosec"].includes(item.department_id) && Number(item.score || 0) >= 7) return true;
  return false;
}

function normalizeDepartment(department) {
  return {
    ...department,
    search_terms: [...new Set([department.name, ...(department.keywords || [])])]
      .map((term) => String(term).trim())
      .filter(Boolean)
  };
}

function segmentArticle(article) {
  const chunks = [];
  if (article.title) chunks.push({ kind: "title", text: article.title, weight: 2.5 });
  if (article.description) {
    for (const sentence of splitSentences(article.description)) {
      chunks.push({ kind: "description", text: sentence, weight: 1.4 });
    }
  }
  if (article.body_text) {
    for (const paragraph of String(article.body_text).split(/\n{2,}/)) {
      const text = cleanText(paragraph);
      if (text.length >= 30) chunks.push({ kind: "body", text, weight: 1 });
    }
  }
  return chunks
    .filter((chunk) => chunk.text.length >= 8)
    .slice(0, 80)
    .map((chunk, index) => ({
      id: stableId([article.id, chunk.kind, index, chunk.text]),
      index,
      ...chunk
    }));
}

function matchSegment(segment, article, departments, minScore) {
  const haystack = normalizeText(`${article.title || ""} ${segment.text}`);
  const matches = [];
  for (const department of departments) {
    let score = 0;
    const matched = [];
    for (const term of department.search_terms) {
      const normalizedTerm = normalizeText(term);
      if (!normalizedTerm) continue;
      const count = countIncludes(haystack, normalizedTerm);
      if (!count) continue;
      const termWeight = normalizedTerm.length >= 4 ? 1.6 : 1;
      score += count * termWeight * segment.weight;
      matched.push(term);
    }
    if (score >= minScore) {
      matches.push({
        department_id: department.id,
        department: department.name,
        score: Number(score.toFixed(2)),
        matched_keywords: [...new Set(matched)].slice(0, 8)
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 4);
}

function normalizeLlmResult(result) {
  return {
    article_id: String(result.article_id || ""),
    company_relevant: Boolean(result.company_relevant),
    company_reason: cleanText(result.company_reason || result.reason || ""),
    departments: Array.isArray(result.departments)
      ? result.departments
          .map((department) => ({
            department_id: String(department.department_id || ""),
            score: clamp(Number(department.score || 0), 0, 1),
            evidence_text: cleanText(department.evidence_text || ""),
            evidence_type: ["sentence", "paragraph", "article"].includes(department.evidence_type)
              ? department.evidence_type
              : "article",
            reason: cleanText(department.reason || "")
          }))
          .filter((department) => department.department_id)
      : []
  };
}

function maxDepartmentScore(departments) {
  const max = Math.max(0.5, ...(departments || []).map((department) => Number(department.score || 0)));
  return Number((max * 10).toFixed(2));
}

function bodyExcerpt(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 4)
    .join("\n\n")
    .slice(0, 2400);
}

function bestItemPerArticle(items) {
  const map = new Map();
  for (const item of items) {
    const existing = map.get(item.article_id);
    if (
      !existing ||
      sourcePriority(item.source) > sourcePriority(existing.source) ||
      item.score > existing.score ||
      item.segment_text.length > existing.segment_text.length
    ) {
      map.set(item.article_id, item);
    }
  }
  return [...map.values()];
}

function sortBriefItems(a, b) {
  const sourceOrder = sourcePriority(b.source) - sourcePriority(a.source);
  if (sourceOrder !== 0) return sourceOrder;
  const scoreOrder = Number(b.score || 0) - Number(a.score || 0);
  if (scoreOrder !== 0) return scoreOrder;
  return String(b.published_at || "").localeCompare(String(a.published_at || ""));
}

function sourcePriority(source) {
  return source === "llm" ? 2 : 1;
}

function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|(?<=다\.)\s+|(?<=요\.)\s+/u)
    .map(cleanText)
    .filter(Boolean);
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

function countIncludes(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + Math.max(term.length, 1));
  }
  return count;
}

async function updateIndex(targetDate, briefs) {
  const indexPath = path.join(dataDir, "index.json");
  let index = { runs: [] };
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {
    index = { runs: [] };
  }
  index.runs = (index.runs || []).map((run) =>
    run.target_date === targetDate
      ? {
          ...run,
          brief_path: `data/${targetDate}/briefs.json`,
          relevant_article_count: briefs.relevant_article_count,
          relevant_department_count: briefs.relevant_department_count,
          analyzed_at: briefs.generated_at,
          analyzer: briefs.analyzer
        }
      : run
  );
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") args.date = argv[++index];
    else if (arg === "--min-score") args.minScore = argv[++index];
    else if (arg === "--max-items-per-department") args.maxItemsPerDepartment = argv[++index];
    else if (arg === "--max-overall-items") args.maxOverallItems = argv[++index];
    else if (arg === "--llm-max-articles") args.llmMaxArticles = argv[++index];
    else if (arg === "--llm-batch-size") args.llmBatchSize = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/analyze.mjs --date YYYY-MM-DD [--min-score 2] [--llm-max-articles 80]"
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
