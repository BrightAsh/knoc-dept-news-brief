const state = {
  runs: [],
  selectedDate: null,
  visibleMonth: null,
  activeView: "briefs",
};

const els = {
  monthLabel: document.querySelector("#monthLabel"),
  calendarGrid: document.querySelector("#calendarGrid"),
  runCount: document.querySelector("#runCount"),
  articleTotal: document.querySelector("#articleTotal"),
  selectedDate: document.querySelector("#selectedDate"),
  briefTotal: document.querySelector("#briefTotal"),
  articleHeading: document.querySelector("#articleHeading"),
  briefSummary: document.querySelector("#briefSummary"),
  publisherCounts: document.querySelector("#publisherCounts"),
  departmentBriefs: document.querySelector("#departmentBriefs"),
  articleList: document.querySelector("#articleList"),
  prevMonth: document.querySelector("#prevMonth"),
  nextMonth: document.querySelector("#nextMonth"),
};

els.prevMonth.addEventListener("click", () => shiftMonth(-1));
els.nextMonth.addEventListener("click", () => shiftMonth(1));

init().catch((error) => {
  els.articleList.innerHTML = `<div class="empty-state">데이터를 불러오지 못했습니다: ${escapeHtml(error.message)}</div>`;
});

async function init() {
  const index = await fetchJson("data/index.json");
  state.runs = [...(index.runs || [])].sort((a, b) =>
    a.target_date.localeCompare(b.target_date),
  );

  const latest = state.runs.at(-1);
  state.selectedDate = latest?.target_date || todayKey();
  state.visibleMonth = monthKey(state.selectedDate);

  els.runCount.textContent = `${state.runs.length.toLocaleString("ko-KR")}일`;
  els.articleTotal.textContent = `${state.runs
    .reduce((sum, run) => sum + Number(run.article_count || 0), 0)
    .toLocaleString("ko-KR")}건`;

  renderCalendar();
  if (latest) await selectDate(state.selectedDate);
}

function renderCalendar() {
  const [year, month] = state.visibleMonth.split("-").map(Number);
  const firstDate = new Date(year, month - 1, 1);
  const lastDate = new Date(year, month, 0);
  const startOffset = firstDate.getDay();
  const daysInMonth = lastDate.getDate();
  const runMap = new Map(state.runs.map((run) => [run.target_date, run]));

  els.monthLabel.textContent = `${year}년 ${month}월`;
  els.calendarGrid.innerHTML = "";

  for (let index = 0; index < startOffset; index += 1) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "day-button empty";
    empty.disabled = true;
    els.calendarGrid.append(empty);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const run = runMap.get(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "day-button",
      run ? "has-data" : "no-data",
      date === state.selectedDate ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    button.innerHTML = `
      <span class="day-number">${day}</span>
      <span class="day-count">${run ? `${Number(run.article_count || 0).toLocaleString("ko-KR")}건` : "0건"}</span>
    `;
    button.addEventListener("click", () => selectDate(date));
    els.calendarGrid.append(button);
  }
}

async function selectDate(date) {
  state.selectedDate = date;
  els.selectedDate.textContent = date;
  renderCalendar();

  const run = state.runs.find((entry) => entry.target_date === date);
  if (!run) {
    els.articleHeading.textContent = `${date} 수집 자료 없음`;
    els.briefSummary.textContent = "";
    els.publisherCounts.innerHTML = "";
    els.departmentBriefs.innerHTML = "";
    els.briefTotal.textContent = "0개";
    els.articleList.innerHTML = `<div class="empty-state">이 날짜에는 아직 수집된 기사가 없습니다.</div>`;
    return;
  }

  els.articleHeading.textContent = `${date} 기사 ${Number(run.article_count || 0).toLocaleString("ko-KR")}건`;
  els.articleList.innerHTML = `<div class="empty-state">기사 목록을 불러오는 중입니다.</div>`;
  els.departmentBriefs.innerHTML = `<div class="empty-state">부서별 후보를 불러오는 중입니다.</div>`;

  const [articles, briefs] = await Promise.all([
    fetchJson(run.path || `data/${date}/articles.json`),
    fetchJson(run.brief_path || `data/${date}/briefs.json`).catch(() => null),
  ]);
  renderPublisherCounts(articles);
  renderBriefs(briefs);
  renderArticles(articles);
}

function renderPublisherCounts(articles) {
  const counts = new Map();
  for (const article of articles) {
    counts.set(article.publisher, (counts.get(article.publisher) || 0) + 1);
  }
  els.publisherCounts.innerHTML = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
    .map(([publisher, count]) => `<span>${escapeHtml(publisher)} ${count.toLocaleString("ko-KR")}건</span>`)
    .join("");
}

function renderBriefs(briefs) {
  if (!briefs) {
    els.briefTotal.textContent = "0개";
    els.briefSummary.textContent = "아직 이 날짜의 부서별 분석 파일이 없습니다.";
    els.departmentBriefs.innerHTML = `<div class="empty-state">분석 전입니다. 수집 후 analyze 스크립트를 실행하면 이 영역에 부서별 후보가 표시됩니다.</div>`;
    return;
  }

  const departments = [...(briefs.departments || [])]
    .filter((department) => Number(department.article_count || 0) > 0)
    .sort((a, b) => Number(b.article_count || 0) - Number(a.article_count || 0));

  els.briefTotal.textContent = `${departments.length.toLocaleString("ko-KR")}개`;
  els.briefSummary.textContent = `${briefs.analyzer} 기준 관련 기사 ${Number(briefs.relevant_article_count || 0).toLocaleString("ko-KR")}건을 ${departments.length.toLocaleString("ko-KR")}개 부서 후보로 묶었습니다.`;

  if (!departments.length) {
    els.departmentBriefs.innerHTML = `<div class="empty-state">부서와 연결된 후보 문장·문단이 없습니다.</div>`;
    return;
  }

  els.departmentBriefs.innerHTML = departments
    .map((department) => {
      const keywords = (department.top_keywords || [])
        .slice(0, 5)
        .map((item) => `<span>${escapeHtml(item.keyword)} ${Number(item.count || 0).toLocaleString("ko-KR")}</span>`)
        .join("");
      const items = (department.items || [])
        .slice(0, 4)
        .map(
          (item) => `
            <li>
              <a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "제목 없음")}</a>
              <p>${escapeHtml(item.segment_text || "")}</p>
              <small>${escapeHtml(item.publisher || "-")} · 점수 ${Number(item.score || 0).toLocaleString("ko-KR")} · ${escapeHtml((item.matched_keywords || []).join(", "))}</small>
            </li>
          `,
        )
        .join("");
      return `
        <article class="department-card">
          <header>
            <div>
              <h3>${escapeHtml(department.department)}</h3>
              <p>${escapeHtml(department.role || "")}</p>
            </div>
            <strong>${Number(department.article_count || 0).toLocaleString("ko-KR")}건</strong>
          </header>
          <div class="keyword-row">${keywords}</div>
          <ol>${items}</ol>
        </article>
      `;
    })
    .join("");
}

function renderArticles(articles) {
  if (!articles.length) {
    els.articleList.innerHTML = `<div class="empty-state">기사 목록이 비어 있습니다.</div>`;
    return;
  }

  els.articleList.innerHTML = articles
    .map((article) => {
      const time = formatDateTime(article.published_at);
      const description = article.description
        ? `<p class="article-description">${escapeHtml(article.description)}</p>`
        : "";
      return `
        <article class="article-item">
          <div class="publisher">${escapeHtml(article.publisher || "-")}</div>
          <div>
            <a class="article-title" href="${escapeAttribute(article.url)}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(article.title || "제목 없음")}
            </a>
            <div class="article-meta">${escapeHtml(time)} · ${escapeHtml(article.source_type || "-")}</div>
            ${description}
          </div>
        </article>
      `;
    })
    .join("");
}

function shiftMonth(delta) {
  const [year, month] = state.visibleMonth.split("-").map(Number);
  const next = new Date(year, month - 1 + delta, 1);
  state.visibleMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  renderCalendar();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function monthKey(date) {
  return date.slice(0, 7);
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value) {
  if (!value) return "발행시각 미상";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
