import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "config", "sources.json");
const dataDir = path.join(rootDir, "data");
const timeZone = "Asia/Seoul";
const execFileAsync = promisify(execFile);

const USER_AGENT =
  "knoc-dept-news-brief/0.1 (+https://github.com/BrightAsh/knoc-dept-news-brief)";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDate = resolveTargetDate(args.date || "yesterday");
  const includeBody = Boolean(args.includeBody);
  const maxArticleMetaFetch = Number(args.maxArticleMetaFetch || 120);
  const bodyConcurrency = Number(args.bodyConcurrency || 6);
  const maxBodyFetch = Number(args.maxBodyFetch || 0);

  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const sources = (config.sources || []).filter((source) => source.enabled !== false);
  const collectedAt = new Date().toISOString();
  const logs = [];
  const allArticles = [];

  for (const source of sources) {
    const started = Date.now();
    try {
      const items =
        source.type === "rss"
          ? await collectRssSource(source, targetDate)
          : source.type === "sitemap"
            ? await collectSitemapSource(source, targetDate, maxArticleMetaFetch)
            : [];

      allArticles.push(...items);
      logs.push({
        source_id: source.id,
        publisher: source.publisher,
        type: source.type,
        status: "ok",
        count: items.length,
        elapsed_ms: Date.now() - started,
        url: source.url
      });
    } catch (error) {
      logs.push({
        source_id: source.id,
        publisher: source.publisher,
        type: source.type,
        status: "error",
        count: 0,
        elapsed_ms: Date.now() - started,
        url: source.url,
        message: messageOf(error)
      });
    }
  }

  const deduped = dedupeArticles(allArticles);
  const enriched = includeBody
    ? await enrichArticlesWithBody(deduped, { bodyConcurrency, maxBodyFetch })
    : deduped;

  const dayDir = path.join(dataDir, targetDate);
  await fs.mkdir(dayDir, { recursive: true });
  await fs.writeFile(
    path.join(dayDir, "articles.json"),
    `${JSON.stringify(enriched, null, 2)}\n`,
    "utf8"
  );

  const run = {
    target_date: targetDate,
    timezone: timeZone,
    collected_at: collectedAt,
    include_body: includeBody,
    source_count: sources.length,
    article_count: enriched.length,
    logs
  };
  await fs.writeFile(path.join(dayDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await updateIndex(targetDate, run);

  console.log(
    JSON.stringify(
      {
        target_date: targetDate,
        article_count: enriched.length,
        output_dir: path.relative(rootDir, dayDir),
        include_body: includeBody
      },
      null,
      2
    )
  );
}

async function collectRssSource(source, targetDate) {
  const xml = await fetchText(source.url);
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const articles = [];

  for (const block of blocks) {
    let title = cleanText(firstTag(block, "title"));
    const url = normalizeArticleUrl(firstTag(block, "link") || firstTag(block, "guid"));
    let description = cleanText(
      firstTag(block, "description") || firstTag(block, "content:encoded")
    );
    const rawDate =
      firstTag(block, "pubDate") ||
      firstTag(block, "dc:date") ||
      firstTag(block, "published") ||
      firstTag(block, "updated");
    let publishedAt = normalizeDateTime(rawDate);
    let dateKey = publishedAt ? dateInKst(new Date(publishedAt)) : null;
    let dateConfidence = dateKey ? "feed-date" : "unknown";

    if (!url || !title) continue;
    if (!dateKey) {
      const meta = await fetchArticleMeta(url).catch(() => ({}));
      if (meta.title) title = title || meta.title;
      if (meta.description) description = description || meta.description;
      if (meta.published_at) {
        publishedAt = meta.published_at;
        dateKey = dateInKst(new Date(publishedAt));
        dateConfidence = "article-meta";
      }
    }
    if (!dateKey || dateKey !== targetDate) continue;

    articles.push(
      makeArticle({
        publisher: source.publisher,
        source_id: source.id,
        source_type: "rss",
        source_url: source.url,
        section: source.section || null,
        title,
        url,
        description,
        published_at: publishedAt,
        matched_date: dateKey,
        date_confidence: dateConfidence
      })
    );
  }

  return articles;
}

async function collectSitemapSource(source, targetDate, maxArticleMetaFetch) {
  const xml = await fetchText(source.url);
  const blocks = [...xml.matchAll(/<url\b[\s\S]*?<\/url>/gi)].map((match) => match[0]);
  const candidates = [];

  for (const block of blocks) {
    const url = normalizeArticleUrl(firstTag(block, "loc"));
    if (!url) continue;
    const urlDate = dateFromUrl(url);
    if (urlDate && urlDate !== targetDate) continue;
    const sitemapTitle = cleanText(
      firstTag(block, "news:title") ||
        firstTag(block, "image:title") ||
        firstTag(block, "title")
    );
    const lastmodRaw =
      firstTag(block, "news:publication_date") ||
      firstTag(block, "lastmod") ||
      firstTag(block, "publication_date");
    const lastmod = normalizeDateTime(lastmodRaw);
    const lastmodDate = lastmod ? dateInKst(new Date(lastmod)) : null;
    if (lastmodDate && lastmodDate !== targetDate) continue;

    candidates.push({
      url,
      title: sitemapTitle,
      lastmod,
      lastmod_date: lastmodDate,
      url_date: urlDate
    });
  }

  const dated = candidates.filter((item) => item.lastmod_date === targetDate);
  const undated = candidates.filter((item) => !item.lastmod_date).slice(0, maxArticleMetaFetch);
  const articleCandidates = dated.length ? dated : undated;
  const articles = [];

  for (const candidate of articleCandidates) {
    let meta = {};
    if (!candidate.lastmod_date) {
      meta = await fetchArticleMeta(candidate.url).catch((error) => ({
        fetch_error: messageOf(error)
      }));
    }

    const publishedAt = meta.published_at || candidate.lastmod || null;
    const dateKey = candidate.url_date || (publishedAt ? dateInKst(new Date(publishedAt)) : candidate.lastmod_date);
    if (dateKey && dateKey !== targetDate) continue;

    articles.push(
      makeArticle({
        publisher: source.publisher,
        source_id: source.id,
        source_type: "sitemap",
        source_url: source.url,
        section: source.section || null,
        title: meta.title || candidate.title || titleFromUrl(candidate.url),
        url: candidate.url,
        description: meta.description || "",
        published_at: publishedAt,
        matched_date: dateKey || targetDate,
        date_confidence: dateKey ? (meta.published_at ? "article-meta" : "sitemap-lastmod") : "undated-sitemap-candidate",
        meta_fetch_error: meta.fetch_error || null
      })
    );
  }

  return articles;
}

async function fetchArticleMeta(url) {
  const html = await fetchText(url);
  return {
    title: extractMeta(html, ["og:title", "twitter:title"]) || cleanText(firstTag(html, "title")),
    description:
      extractMeta(html, ["og:description", "description", "twitter:description"]) || "",
    published_at: extractPublishedAt(html)
  };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/xml,text/xml,application/rss+xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return decodeResponseBuffer(buffer, response.headers.get("content-type") || "");
  } catch (error) {
    return await fetchTextWithCurl(url, error);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithCurl(url, originalError) {
  const curlBin = process.env.CURL_BIN || (process.platform === "win32" ? "curl.exe" : "curl");
  try {
    const { stdout } = await execFileAsync(
      curlBin,
      [
        "-k",
        "-L",
        "-sS",
        "--compressed",
        "--max-time",
        "25",
        "-A",
        USER_AGENT,
        "-H",
        "Accept: text/html,application/xhtml+xml,application/xml,text/xml,application/rss+xml;q=0.9,*/*;q=0.8",
        url
      ],
      {
        encoding: "buffer",
        maxBuffer: 30 * 1024 * 1024
      }
    );
    if (!stdout) throw new Error("empty curl response");
    return decodeResponseBuffer(Buffer.from(stdout), "");
  } catch (curlError) {
    throw new Error(`fetch failed: ${messageOf(originalError)}; curl fallback failed: ${messageOf(curlError)}`);
  }
}

async function enrichArticlesWithBody(articles, options) {
  const maxBodyFetch = Number(options.maxBodyFetch || 0);
  const targets = maxBodyFetch > 0 ? articles.slice(0, maxBodyFetch) : articles;
  const passthrough = maxBodyFetch > 0 ? articles.slice(maxBodyFetch) : [];
  const enriched = new Array(targets.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(options.bodyConcurrency || 6), targets.length || 1));

  async function worker() {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const article = targets[index];
      try {
        const html = await fetchText(article.url);
        const body = extractBodyText(html);
        enriched[index] = {
          ...article,
          body_text: body,
          body_fetched_at: new Date().toISOString(),
          body_fetch_status: body ? "fetched" : "empty"
        };
      } catch (error) {
        enriched[index] = {
          ...article,
          body_text: "",
          body_fetch_status: "error",
          body_fetch_error: messageOf(error)
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return [...enriched, ...passthrough];
}

function decodeResponseBuffer(buffer, contentType) {
  const sniff = buffer.toString("latin1", 0, Math.min(buffer.length, 4096));
  const charset =
    contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1] ||
    sniff.match(/<meta[^>]+charset=["']?([^"'>\s]+)/i)?.[1] ||
    sniff.match(/<\?xml[^>]+encoding=["']([^"']+)["']/i)?.[1] ||
    "utf-8";
  const label = normalizeCharset(charset);
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function normalizeCharset(value) {
  const label = String(value || "").trim().toLowerCase();
  if (["euc-kr", "euckr", "ks_c_5601-1987", "ksc5601", "x-windows-949", "windows-949", "cp949"].includes(label)) {
    return "windows-949";
  }
  if (["utf8", "utf-8"].includes(label)) return "utf-8";
  return label || "utf-8";
}

function makeArticle(input) {
  const url = normalizeArticleUrl(input.url);
  return {
    id: stableId([input.publisher, url]),
    publisher: input.publisher,
    title: cleanText(input.title),
    url,
    description: cleanText(input.description || ""),
    published_at: input.published_at || null,
    matched_date: input.matched_date || null,
    date_confidence: input.date_confidence || "unknown",
    source_id: input.source_id,
    source_type: input.source_type,
    source_url: input.source_url,
    section: input.section || null,
    meta_fetch_error: input.meta_fetch_error || null
  };
}

function dedupeArticles(articles) {
  const byUrl = new Map();
  for (const article of articles) {
    const existing = byUrl.get(article.url);
    if (!existing) {
      byUrl.set(article.url, article);
      continue;
    }
    byUrl.set(article.url, {
      ...existing,
      title: existing.title || article.title,
      description: existing.description || article.description,
      published_at: existing.published_at || article.published_at,
      source_id: [...new Set(`${existing.source_id},${article.source_id}`.split(","))].join(",")
    });
  }
  return [...byUrl.values()].sort((a, b) => {
    const dateOrder = String(b.published_at || "").localeCompare(String(a.published_at || ""));
    if (dateOrder !== 0) return dateOrder;
    return a.publisher.localeCompare(b.publisher, "ko") || a.title.localeCompare(b.title, "ko");
  });
}

async function updateIndex(targetDate, run) {
  await fs.mkdir(dataDir, { recursive: true });
  const indexPath = path.join(dataDir, "index.json");
  let index = { runs: [] };
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {
    index = { runs: [] };
  }

  const runs = (index.runs || []).filter((entry) => entry.target_date !== targetDate);
  runs.unshift({
    target_date: targetDate,
    collected_at: run.collected_at,
    article_count: run.article_count,
    include_body: run.include_body,
    path: `data/${targetDate}/articles.json`
  });

  await fs.writeFile(indexPath, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") args.date = argv[++index];
    else if (arg === "--include-body") args.includeBody = true;
    else if (arg === "--max-article-meta-fetch") args.maxArticleMetaFetch = argv[++index];
    else if (arg === "--body-concurrency") args.bodyConcurrency = argv[++index];
    else if (arg === "--max-body-fetch") args.maxBodyFetch = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/collect.mjs [--date YYYY-MM-DD|today|yesterday] [--include-body] [--body-concurrency 6]"
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
    const kstToday = dateInKst(now);
    const date = new Date(`${kstToday}T00:00:00+09:00`);
    date.setUTCDate(date.getUTCDate() - 1);
    return dateInKst(date);
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

function normalizeDateTime(value) {
  const text = cleanText(value);
  if (!text) return null;
  const normalized = text.replace(/(\d{4})\.(\d{1,2})\.(\d{1,2})/, "$1-$2-$3");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function firstTag(text, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function extractMeta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i")
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return cleanText(decodeXml(match[1]));
    }
  }
  return "";
}

function extractPublishedAt(html) {
  const meta =
    extractMeta(html, [
      "article:published_time",
      "article:modified_time",
      "pubdate",
      "publishdate",
      "date",
      "dcterms.created"
    ]) || "";
  if (meta) return normalizeDateTime(meta);

  const jsonLdDate =
    html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] ||
    html.match(/"dateCreated"\s*:\s*"([^"]+)"/i)?.[1] ||
    "";
  return normalizeDateTime(jsonLdDate);
}

function extractBodyText(html) {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const paragraphs = [...withoutNoise.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((text) => text.length >= 30)
    .filter((text, index, arr) => arr.indexOf(text) === index)
    .slice(0, 80);
  return paragraphs.join("\n\n");
}

function cleanText(value) {
  return decodeXml(String(value || ""))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)));
}

function normalizeArticleUrl(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|igshid|ref|outputType)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

function looksLikeArticleUrl(url) {
  return /\/article\/|\/news\/|\/\d{4}\/\d{2}\/\d{2}\//.test(url);
}

function dateFromUrl(url) {
  const match = url.match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname);
  } catch {
    return url;
  }
}

function stableId(parts) {
  return crypto.createHash("sha256").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 16);
}

function messageOf(error) {
  if (error?.name === "AbortError") return "request timeout";
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
