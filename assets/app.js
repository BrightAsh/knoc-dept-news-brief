const state = {
  runs: [],
  selectedDate: null,
  visibleMonth: null,
  selectedDepartmentId: "overall",
  currentArticles: [],
  currentBriefs: null,
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
  departmentNav: document.querySelector("#departmentNav"),
  briefPanel: document.querySelector("#briefPanel"),
  articleList: document.querySelector("#articleList"),
  prevMonth: document.querySelector("#prevMonth"),
  nextMonth: document.querySelector("#nextMonth"),
};

els.prevMonth.addEventListener("click", () => shiftMonth(-1));
els.nextMonth.addEventListener("click", () => shiftMonth(1));

init().catch((error) => {
  els.briefPanel.innerHTML = `<div class="empty-state">데이터를 불러오지 못했습니다. ${escapeHtml(error.message)}</div>`;
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
  state.selectedDepartmentId = "overall";
  els.selectedDate.textContent = date;
  renderCalendar();

  const run = state.runs.find((entry) => entry.target_date === date);
  if (!run) {
    state.currentArticles = [];
    state.currentBriefs = null;
    els.articleHeading.textContent = `${date} 수집 자료 없음`;
    els.briefSummary.textContent = "";
    els.publisherCounts.innerHTML = "";
    els.departmentNav.innerHTML = "";
    els.briefTotal.textContent = "0개";
    els.briefPanel.innerHTML = `<div class="empty-state">이 날짜에는 아직 수집된 기사가 없습니다.</div>`;
    els.articleList.innerHTML = "";
    return;
  }

  els.articleHeading.textContent = `${date} 기사 ${Number(run.article_count || 0).toLocaleString("ko-KR")}건`;
  els.briefPanel.innerHTML = `<div class="empty-state">분석 결과를 불러오는 중입니다.</div>`;
  els.articleList.innerHTML = `<div class="empty-state">기사 목록을 불러오는 중입니다.</div>`;

  const [articles, briefs] = await Promise.all([
    fetchJson(run.path || `data/${date}/articles.json`),
    fetchJson(run.brief_path || `data/${date}/briefs.json`).catch(() => null),
  ]);
  state.currentArticles = articles;
  state.currentBriefs = briefs;

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
    els.departmentNav.innerHTML = "";
    els.briefPanel.innerHTML = `<div class="empty-state">수집 후 analyze 스크립트가 실행되면 전체와 부서별 브리프가 표시됩니다.</div>`;
    return;
  }

  const departments = activeDepartments(briefs);
  const llmLabel = llmStatusLabel(briefs.llm_review);

  els.briefTotal.textContent = `${departments.length.toLocaleString("ko-KR")}개`;
  els.briefSummary.textContent = `${briefs.analyzer} 기준 관련 기사 ${Number(briefs.relevant_article_count || 0).toLocaleString("ko-KR")}건을 분류했습니다. ${llmLabel}`;

  renderDepartmentNav(briefs, departments);
  renderSelectedBrief();
}

function activeDepartments(briefs) {
  return [...(briefs.departments || [])]
    .filter((department) => Number(department.article_count || 0) > 0)
    .sort((a, b) => Number(b.article_count || 0) - Number(a.article_count || 0));
}

function renderDepartmentNav(briefs, departments) {
  const overallCount = Number(briefs.overall?.article_count || briefs.relevant_article_count || 0);
  const items = [
    {
      id: "overall",
      label: "전체",
      count: overallCount,
      role: "회사 업무와 관련 있다고 판단된 기사",
    },
    ...departments.map((department) => ({
      id: department.department_id,
      label: department.department,
      count: Number(department.article_count || 0),
      role: department.role || "",
    })),
  ];

  els.departmentNav.innerHTML = items
    .map(
      (item) => `
        <button class="department-tab ${item.id === state.selectedDepartmentId ? "selected" : ""}" type="button" data-department="${escapeAttribute(item.id)}">
          <span>
            <strong>${escapeHtml(item.label)}</strong>
            <small>${escapeHtml(item.role)}</small>
          </span>
          <em>${item.count.toLocaleString("ko-KR")}</em>
        </button>
      `,
    )
    .join("");

  els.departmentNav.querySelectorAll("button[data-department]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedDepartmentId = button.dataset.department || "overall";
      renderDepartmentNav(briefs, departments);
      renderSelectedBrief();
    });
  });
}

function renderSelectedBrief() {
  const briefs = state.currentBriefs;
  if (!briefs) return;

  if (state.selectedDepartmentId === "overall") {
    renderOverallPanel(briefs.overall || { items: [], article_count: briefs.relevant_article_count || 0 });
    return;
  }

  const department = (briefs.departments || []).find(
    (item) => item.department_id === state.selectedDepartmentId,
  );
  if (!department) {
    els.briefPanel.innerHTML = `<div class="empty-state">선택한 부서의 분석 결과가 없습니다.</div>`;
    return;
  }

  els.briefPanel.innerHTML = `
    <header class="panel-header">
      <div>
        <p class="panel-kicker">부서 브리프</p>
        <h3>${escapeHtml(department.department)}</h3>
        <p>${escapeHtml(department.role || "")}</p>
      </div>
      <strong>${Number(department.article_count || 0).toLocaleString("ko-KR")}건</strong>
    </header>
    ${renderEvidenceList(department.items || [])}
  `;
}

function renderOverallPanel(overall) {
  els.briefPanel.innerHTML = `
    <header class="panel-header">
      <div>
        <p class="panel-kicker">전체</p>
        <h3>회사 관련 기사 후보</h3>
        <p>LLM이 한국석유공사 역할과 부서 업무를 기준으로 관련성을 판단한 결과입니다.</p>
      </div>
      <strong>${Number(overall.article_count || 0).toLocaleString("ko-KR")}건</strong>
    </header>
    ${renderEvidenceList(overall.items || [])}
  `;
}

function renderEvidenceList(items) {
  if (!items.length) {
    return `<div class="empty-state">표시할 근거가 없습니다.</div>`;
  }

  return `
    <ol class="evidence-list">
      ${items
        .map((item) => {
          const departments = (item.departments || [])
            .slice(0, 4)
            .map((department) => `<span>${escapeHtml(department.name || department.id)}</span>`)
            .join("");
          const tags = [
            item.source ? `<span>${item.source === "llm" ? "LLM" : escapeHtml(item.source)}</span>` : "",
            item.evidence_type ? `<span>${evidenceLabel(item.evidence_type)}</span>` : "",
            departments,
          ]
            .filter(Boolean)
            .join("");
          return `
            <li class="evidence-item">
              <div class="evidence-meta">
                <span>${escapeHtml(item.publisher || "-")}</span>
                <span>${escapeHtml(formatDateTime(item.published_at))}</span>
              </div>
              <a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "제목 없음")}</a>
              <p>${escapeHtml(item.segment_text || item.reason || "")}</p>
              <div class="tag-row">${tags}</div>
            </li>
          `;
        })
        .join("")}
    </ol>
  `;
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

function llmStatusLabel(review) {
  if (!review?.enabled) return "LLM이 설정되지 않아 자동 분류 결과가 없습니다.";
  if (review.status === "ok") {
    return `${review.provider} ${review.model}로 ${Number(review.analyzed_article_count || 0).toLocaleString("ko-KR")}건을 문맥 검토했습니다.`;
  }
  return `LLM 상태: ${review.status}. LLM이 반환한 결과만 표시합니다.`;
}

function evidenceLabel(value) {
  if (value === "sentence") return "문장";
  if (value === "paragraph") return "문단";
  if (value === "direct") return "직접";
  if (value === "watch") return "관찰";
  return "기사";
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
