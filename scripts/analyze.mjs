import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const departmentsPath = path.join(rootDir, "config", "departments.json");
const analyzerVersion = "rule-keyword-v0";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDate = resolveTargetDate(args.date || "yesterday");
  const maxItemsPerDepartment = Number(args.maxItemsPerDepartment || 40);
  const minScore = Number(args.minScore || 2);

  const dayDir = path.join(dataDir, targetDate);
  const articlesPath = path.join(dayDir, "articles.json");
  const articles = JSON.parse(await fs.readFile(articlesPath, "utf8"));
  const departments = JSON.parse(await fs.readFile(departmentsPath, "utf8")).map(normalizeDepartment);

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
  const allMatches = [];

  for (const article of articles) {
    const segments = segmentArticle(article);
    const articleBest = [];
    for (const segment of segments) {
      const matches = matchSegment(segment, article, departments, minScore);
      for (const match of matches) {
        const brief = departmentMap.get(match.department_id);
        const articleIds = articleIdsByDepartment.get(match.department_id);
        const keywordCounts = keywordCountsByDepartment.get(match.department_id);
        articleIds.add(article.id);
        brief.segment_count += 1;
        for (const keyword of match.matched_keywords) {
          keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
        }
        brief.items.push({
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
          evidence_type: match.score >= 5 ? "direct" : "watch"
        });
        articleBest.push(match.department_id);
        allMatches.push({
          article_id: article.id,
          segment_id: segment.id,
          department_id: match.department_id,
          score: match.score,
          matched_keywords: match.matched_keywords
        });
      }
    }
    article.department_candidates = [...new Set(articleBest)];
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
      .sort((a, b) => b.score - a.score || String(b.published_at || "").localeCompare(String(a.published_at || "")))
      .slice(0, maxItemsPerDepartment);
    return brief;
  });

  const relevantDepartmentCount = departmentsOutput.filter((department) => department.article_count > 0).length;
  const relevantArticleCount = new Set(allMatches.map((match) => match.article_id)).size;
  const briefs = {
    target_date: targetDate,
    generated_at: new Date().toISOString(),
    analyzer: analyzerVersion,
    input_article_count: articles.length,
    relevant_article_count: relevantArticleCount,
    relevant_department_count: relevantDepartmentCount,
    departments: departmentsOutput
  };

  await fs.writeFile(path.join(dayDir, "briefs.json"), `${JSON.stringify(briefs, null, 2)}\n`, "utf8");
  await updateIndex(targetDate, briefs);

  console.log(
    JSON.stringify(
      {
        target_date: targetDate,
        analyzer: analyzerVersion,
        relevant_article_count: relevantArticleCount,
        relevant_department_count: relevantDepartmentCount,
        output: `data/${targetDate}/briefs.json`
      },
      null,
      2
    )
  );
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

function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?。！？])\s+|(?<=다\.)\s+|(?<=요\.)\s+|(?<=니다\.)\s+/)
    .map(cleanText)
    .filter(Boolean);
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

function countIncludes(text, term) {
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + term.length);
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
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/analyze.mjs --date YYYY-MM-DD [--min-score 2]");
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
    timeZone: "Asia/Seoul",
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
