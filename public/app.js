const state = {
  labels: {},
  sectors: [],
  analysisRows: [],
  analysisColumns: [],
  filingRows: [],
  filingColumns: [],
  activeWorkspace: "analysis",
  activeView: "analysis",
  pdfDownloadUrl: "",
  lastFocusedElement: null,
  analysisWarnings: [],
  analysisRawCount: 0,
  lastAnalysisPayload: null
};

const DEFAULT_LABELS = {
  rank_operating_income: "영업이익순위",
  corp_name: "회사명",
  stock_code: "종목코드",
  bsns_year: "사업연도",
  report_label: "보고서명",
  report_nm: "공시명",
  pdf: "원문",
  fs_div: "재무제표",
  collection_status: "수집상태",
  failure_reason: "미확보사유",
  data_source: "데이터출처",
  operating_revenue: "영업수익(공식)",
  operating_revenue_estimate: "영업수익(추정)",
  operating_revenue_estimate_basis: "영업수익(추정) 기준",
  operating_income: "영업이익",
  operating_income_yoy: "영업이익 YoY",
  pretax_income: "세전이익",
  pretax_income_yoy: "세전이익 YoY",
  net_income: "당기순이익",
  net_income_yoy: "당기순이익 YoY",
  equity: "자본총계(자기자본)",
  operating_margin: "영업이익률",
  operating_margin_estimate: "영업이익률(추정)",
  roe: "ROE",
  debt_ratio: "부채비율",
  rcept_dt: "접수일",
  rcept_no: "접수번호"
};

const FS_DIV_LABELS = {
  CFS: "연결재무제표",
  OFS: "별도재무제표"
};

const AMOUNT_COLUMNS = new Set([
  "operating_revenue",
  "operating_revenue_estimate",
  "operating_income",
  "pretax_income",
  "net_income",
  "equity"
]);

const $ = (id) => document.getElementById(id);

init().catch((error) => setStatus(error.message, true));

async function init() {
  bindEvents();
  const config = await apiGet("/api/config");
  state.labels = { ...DEFAULT_LABELS, ...(config.labels || {}) };
  state.sectors = config.sectors || [];
  populateSectors(state.sectors);
  state.analysisColumns = config.metricColumns || [];
  state.filingColumns = config.filingColumns || [];
  renderTable($("analysisTable"), [], state.analysisColumns);
  renderTable($("filingsTable"), [], state.filingColumns);
  renderStrategyDashboard();
  renderChart();
  renderTrend();
  renderVisualPanel();
  setStatus("대기 중");
}

function bindEvents() {
  $("analyzeButton").addEventListener("click", runAnalysis);
  $("filingsButton").addEventListener("click", listFilings);
  $("exportButton").addEventListener("click", downloadCurrentFile);
  $("reportButton").addEventListener("click", downloadStrategyReport);
  $("chartMetricSelect").addEventListener("change", renderChart);
  $("trendMetricSelect").addEventListener("change", renderTrend);
  $("pdfCloseButton").addEventListener("click", closePdfViewer);
  $("pdfDownloadButton").addEventListener("click", () => {
    if (state.pdfDownloadUrl) downloadUrl(state.pdfDownloadUrl);
  });
  document.querySelectorAll("[data-close-pdf]").forEach((element) => {
    element.addEventListener("click", closePdfViewer);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePdfViewer();
  });
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll(".workspace-tab").forEach((button) => {
    button.addEventListener("click", () => switchWorkspace(button.dataset.workspace));
  });
}

function populateSectors(sectors) {
  const select = $("sectorSelect");
  select.innerHTML = "";
  for (const sector of sectors) {
    const option = document.createElement("option");
    option.value = sector.name;
    option.textContent = `${sectorLabel(sector.name)} (${sector.companyCount})`;
    option.title = sector.description || sector.name;
    select.appendChild(option);
  }
}

async function runAnalysis() {
  const payload = {
    sector: $("sectorSelect").value,
    years: parseYears($("yearsInput").value),
    reports: selectedReports(),
    fsDiv: $("fsDivSelect").value,
    fallbackOfs: $("fallbackOfsInput").checked,
    xbrlFallback: $("xbrlFallbackInput").checked,
    final: $("finalOnlyInput").checked,
    limit: Number($("limitInput").value || 0),
    concurrency: 2
  };
  if (!payload.years.length || !payload.reports.length) {
    setStatus("사업연도와 보고서 종류를 확인하세요.", true);
    return;
  }

  setBusy(true);
  setStatus(`분석 중: ${payload.years.join(", ")} / ${payload.reports.length}개 보고서`);
  try {
    const totalCompanies = selectedCompanyCount(payload.sector, payload.limit);
    const batchSize = analysisBatchSize();
    const batches = [];
    for (let offset = 0; offset < totalCompanies; offset += batchSize) {
      batches.push({ offset, limit: Math.min(batchSize, totalCompanies - offset) });
    }

    const combined = {
      rows: [],
      warnings: [],
      rawCount: 0,
      columns: state.analysisColumns
    };
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      setStatus(`분석 중: ${index + 1}/${batches.length} 묶음 (${batch.offset + 1}-${batch.offset + batch.limit}/${totalCompanies})`);
      const result = await apiPost("/api/analyze", { ...payload, offset: batch.offset, limit: batch.limit });
      combined.rows.push(...(result.rows || []));
      combined.warnings.push(...(result.warnings || []));
      combined.rawCount += result.rawCount || 0;
      combined.columns = result.columns || combined.columns;
    }

    state.analysisRows = rerankRows(combined.rows);
    state.analysisColumns = combined.columns || state.analysisColumns;
    state.analysisWarnings = combined.warnings;
    state.analysisRawCount = combined.rawCount || 0;
    state.lastAnalysisPayload = payload;
    renderTable($("analysisTable"), state.analysisRows, state.analysisColumns);
    renderStrategyDashboard();
    renderChart();
    renderTrend();
    renderVisualPanel();
    switchWorkspace("analysis");
    switchView("analysis");
    const collected = state.analysisRows.filter((row) => row.collection_status === "수집 완료").length;
    $("summaryLine").textContent = `수집 ${collected}/${state.analysisRows.length} | 원천 ${combined.rawCount || 0}행`;
    $("warningText").textContent = combined.warnings.length ? `경고 ${combined.warnings.length}건` : "";
    setStatus("분석 완료");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

function selectedCompanyCount(sectorName, limit) {
  const sector = state.sectors.find((item) => item.name === sectorName);
  const sectorCount = sector?.companyCount || 0;
  const requested = Number(limit || 0);
  return requested > 0 ? Math.min(requested, sectorCount || requested) : sectorCount;
}

function analysisBatchSize() {
  return 1;
}

function rerankRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    row.rank_operating_income = "";
    if (row.collection_status !== "수집 완료" || row.operating_income === null || row.operating_income === undefined || row.operating_income === "") {
      continue;
    }
    const key = `${row.bsns_year}|${row.reprt_code || row.report_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group
      .sort((a, b) => Number(b.operating_income ?? -1e30) - Number(a.operating_income ?? -1e30))
      .forEach((row, index) => {
        row.rank_operating_income = index + 1;
      });
  }
  return rows.sort((a, b) => {
    const left = `${a.bsns_year || ""}|${a.reprt_code || a.report_key || ""}|${String(a.rank_operating_income || 9999).padStart(4, "0")}|${a.corp_name || ""}`;
    const right = `${b.bsns_year || ""}|${b.reprt_code || b.report_key || ""}|${String(b.rank_operating_income || 9999).padStart(4, "0")}|${b.corp_name || ""}`;
    return left.localeCompare(right);
  });
}

async function listFilings() {
  const params = new URLSearchParams({
    sector: $("sectorSelect").value,
    days: $("daysInput").value || "30",
    limit: $("limitInput").value || "0",
    final: String($("finalOnlyInput").checked)
  });
  setBusy(true);
  setStatus("공시 조회 중");
  try {
    const result = await apiGet(`/api/filings?${params}`);
    state.filingRows = result.rows || [];
    state.filingColumns = result.columns || state.filingColumns;
    renderTable($("filingsTable"), state.filingRows, state.filingColumns);
    switchView("filings");
    switchWorkspace("data");
    $("summaryLine").textContent = `공시 ${state.filingRows.length}건 | ${formatDate(result.start)}-${formatDate(result.end)}`;
    $("warningText").textContent = "";
    setStatus("공시 조회 완료");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

function renderTable(table, rows, columns) {
  table.innerHTML = "";
  if (!columns.length) return;
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = displayLabel(column);
    if (column === "pdf") th.className = "document-column";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      td.dataset.column = column;
      if (column === "pdf") {
        td.className = "document-column";
        td.appendChild(documentActions(row));
      } else if (column === "collection_status") {
        td.appendChild(statusChip(row[column]));
      } else {
        td.textContent = formatCell(row[column], column);
        td.title = formatFullCell(row[column], column) || td.textContent;
        applyCellTone(td, row[column], column);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columns.length;
    cell.className = "empty";
    cell.textContent = "데이터 없음";
    row.appendChild(cell);
    tbody.appendChild(row);
  }
  $("exportButton").disabled = !currentRows().length;
  updateDataSubtitle();
}

function documentActions(row) {
  const wrap = document.createElement("div");
  wrap.className = "doc-actions";
  const viewButton = document.createElement("button");
  viewButton.type = "button";
  viewButton.textContent = "원문 보기";
  viewButton.ariaLabel = `${row.corp_name || "회사"} 원문 PDF 보기`;
  viewButton.disabled = !row.rcept_no;
  viewButton.addEventListener("click", () => openPdfViewer(row));

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "다운로드";
  downloadButton.ariaLabel = `${row.corp_name || "회사"} 원문 PDF 다운로드`;
  downloadButton.disabled = !row.rcept_no;
  downloadButton.addEventListener("click", () => downloadPdf(row));

  wrap.append(viewButton, downloadButton);
  return wrap;
}

function statusChip(value) {
  const span = document.createElement("span");
  span.className = `status-chip ${value === "수집 완료" ? "" : "missing"}`;
  span.textContent = value || "미확보";
  return span;
}

function applyCellTone(cell, value, column) {
  if (value === null || value === undefined || value === "") {
    cell.classList.add("empty-cell");
    return;
  }
  const parsed = numeric(value);
  if (!Number.isFinite(parsed)) {
    cell.classList.add("muted-cell");
    return;
  }
  cell.classList.add("numeric-cell");
  if (isRatioColumn(column)) cell.classList.add("ratio-cell");
  if (parsed < 0) cell.classList.add("negative-cell");
  if (parsed > 0) cell.classList.add("positive-cell");
}

function openPdfViewer(row) {
  const { inlineUrl, downloadUrl, fileName } = pdfUrls(row);
  state.pdfDownloadUrl = downloadUrl;
  state.lastFocusedElement = document.activeElement;
  $("pdfModalTitle").textContent = row.corp_name ? `${row.corp_name} 원문 보고서` : "원문 보고서";
  $("pdfModalMeta").textContent = [row.report_label || row.report_nm, formatDate(row.rcept_dt), row.rcept_no].filter(Boolean).join(" · ");
  $("pdfFrame").src = inlineUrl;
  $("pdfDownloadButton").dataset.fileName = fileName;
  $("pdfModal").classList.add("is-open");
  $("pdfModal").setAttribute("aria-hidden", "false");
  $("pdfCloseButton").focus();
}

function closePdfViewer() {
  const modal = $("pdfModal");
  if (!modal.classList.contains("is-open")) return;
  const restoreFocus = state.lastFocusedElement instanceof HTMLElement ? state.lastFocusedElement : $("analyzeButton");
  restoreFocus.focus();
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  $("pdfFrame").src = "about:blank";
  state.pdfDownloadUrl = "";
  state.lastFocusedElement = null;
}

function downloadPdf(row) {
  downloadUrl(pdfUrls(row).downloadUrl);
}

function pdfUrls(row) {
  const label = row.report_label || row.report_nm || "report";
  const fileName = sanitizeFileName(`${row.rcept_dt || ""}_${row.corp_name || ""}_${label}_${row.rcept_no}.pdf`);
  const params = new URLSearchParams({ rceptNo: row.rcept_no, fileName });
  const downloadUrl = `/api/pdf?${params}`;
  params.set("inline", "true");
  return { fileName, downloadUrl, inlineUrl: `/api/pdf?${params}` };
}

function renderVisualPanel() {
  const rows = latestComparableRows();
  const collected = state.analysisRows.filter((row) => row.collection_status === "수집 완료");
  const total = state.analysisRows.length;
  const missing = Math.max(total - collected.length, 0);
  const estimateRows = rows.filter((row) => isBlank(row.operating_revenue) && !isBlank(row.operating_revenue_estimate));
  const officialRevenueRows = rows.filter((row) => !isBlank(row.operating_revenue));
  const coverage = total ? collected.length / total : 0;

  if (!total) {
    $("visualSubtitle").textContent = "분석 결과가 나오면 섹터 상태를 그래픽으로 요약합니다.";
    $("coverageGraphic").innerHTML = graphicEmpty("수집 커버리지", "대기 중");
    $("leaderGraphic").innerHTML = graphicEmpty("영업이익 리더", "대기 중");
    $("qualityGraphic").innerHTML = graphicEmpty("데이터 품질", "대기 중");
    return;
  }

  const period = rows[0] ? periodLabel(rows[0]) : "선택 기간";
  $("visualSubtitle").textContent = `${period} 기준 ${rows.length}개 회사`;
  $("coverageGraphic").innerHTML = `
    <div class="graphic-heading">
      <span>수집 커버리지</span>
      <strong>${htmlEscape(percent(collected.length, total))}</strong>
    </div>
    <div class="donut-wrap">
      <div class="donut" style="--coverage:${Math.round(coverage * 360)}deg">
        <span>${collected.length}/${total}</span>
        <small>수집</small>
      </div>
    </div>
    <div class="graphic-foot">${missing ? `미확보 ${missing}건` : "전체 수집 완료"}</div>
  `;

  const leaders = rows
    .map((row) => ({ row, value: chartValue(row, "operating_income") }))
    .filter((item) => Number.isFinite(item.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const maxLeader = Math.max(...leaders.map((item) => Math.abs(item.value)), 1);
  $("leaderGraphic").innerHTML = `
    <div class="graphic-heading">
      <span>영업이익 리더</span>
      <strong>${leaders[0] ? htmlEscape(leaders[0].row.corp_name) : "-"}</strong>
    </div>
    <div class="leader-bars">
      ${leaders.map((item, index) => `
        <div class="leader-row">
          <span>${index + 1}. ${htmlEscape(item.row.corp_name || "")}</span>
          <div class="leader-track"><i class="${item.value < 0 ? "is-negative" : ""}" style="width:${Math.max(4, Math.round((Math.abs(item.value) / maxLeader) * 100))}%"></i></div>
          <b>${htmlEscape(formatMetric(item.value, "operating_income"))}</b>
        </div>
      `).join("")}
    </div>
  `;

  const officialCount = officialRevenueRows.length;
  const estimateCount = estimateRows.length;
  const unavailableCount = Math.max(rows.length - officialCount - estimateCount, 0);
  const qualityTotal = Math.max(rows.length, 1);
  const estimateNames = companyNamesSummary(estimateRows);
  $("qualityGraphic").innerHTML = `
    <div class="graphic-heading">
      <span>데이터 품질</span>
      <strong>${officialCount}개 공식</strong>
    </div>
    <div class="quality-stack" aria-label="공식 ${officialCount}개, 추정 ${estimateCount}개, 공백 ${unavailableCount}개">
      <i class="official" style="width:${(officialCount / qualityTotal) * 100}%"></i>
      <i class="estimate" style="width:${(estimateCount / qualityTotal) * 100}%"></i>
      <i class="missing" style="width:${(unavailableCount / qualityTotal) * 100}%"></i>
    </div>
    <div class="quality-legend">
      <span><i class="official"></i>공식 ${officialCount}</span>
      <span><i class="estimate"></i>추정 ${estimateCount}</span>
      <span><i class="missing"></i>공백 ${unavailableCount}</span>
    </div>
    <div class="graphic-foot">${estimateCount ? `추정 사용: ${htmlEscape(estimateNames)}` : "공식 영업수익 기준 우선"}</div>
  `;
}

function graphicEmpty(title, text) {
  return `<div class="graphic-heading"><span>${htmlEscape(title)}</span><strong>-</strong></div><div class="graphic-empty">${htmlEscape(text)}</div>`;
}

function renderChart() {
  const metric = $("chartMetricSelect").value;
  const rows = state.analysisRows
    .filter((row) => row.collection_status === "수집 완료")
    .map((row) => ({ row, value: chartValue(row, metric) }))
    .filter((item) => Number.isFinite(item.value));
  const chartBody = $("chartBody");
  chartBody.innerHTML = "";
  const isEmpty = !rows.length;
  $("chartPanel").classList.toggle("is-empty", isEmpty);
  chartBody.classList.toggle("is-empty", isEmpty);
  if (!rows.length) {
    chartBody.innerHTML = `<div class="empty-chart">데이터 없음</div>`;
    $("chartSubtitle").textContent = "분석 결과가 나오면 회사별 지표를 비교합니다.";
    return;
  }

  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const visibleRows = rows.slice(0, 12);
  const maxAbs = Math.max(...visibleRows.map((item) => Math.abs(item.value)), 1);
  $("chartSubtitle").textContent = `${displayLabel(metric)} 기준 상위 ${visibleRows.length}개`;

  for (const item of visibleRows) {
    const percent = Math.max(2, Math.round((Math.abs(item.value) / maxAbs) * 100));
    const line = document.createElement("div");
    line.className = "chart-row";
    const name = document.createElement("div");
    name.className = "chart-name";
    name.textContent = item.row.corp_name || "";
    const track = document.createElement("div");
    track.className = "chart-track";
    const bar = document.createElement("div");
    bar.className = `chart-bar ${item.value < 0 ? "negative" : ""}`;
    bar.style.width = `${percent}%`;
    track.appendChild(bar);
    const value = document.createElement("div");
    value.className = "chart-value";
    value.textContent = formatCell(item.value, metric);
    line.append(name, track, value);
    chartBody.appendChild(line);
  }
}

function renderStrategyDashboard() {
  const rows = latestComparableRows();
  const kpiGrid = $("kpiGrid");
  const insightList = $("insightList");
  const groupSummary = $("groupSummary");
  kpiGrid.innerHTML = "";
  insightList.innerHTML = "";
  groupSummary.innerHTML = "";

  if (!state.analysisRows.length) {
    kpiGrid.innerHTML = `<div class="empty-chart">데이터 없음</div>`;
    $("strategySubtitle").textContent = "분석 결과가 나오면 핵심 판단 지표를 요약합니다.";
    insightList.appendChild(emptyListItem("분석 실행 후 자동으로 인사이트가 생성됩니다."));
    groupSummary.innerHTML = `<div class="empty-mini">데이터 없음</div>`;
    $("reportButton").disabled = true;
    return;
  }

  const collected = state.analysisRows.filter((row) => row.collection_status === "수집 완료");
  const missing = state.analysisRows.length - collected.length;
  const periodLabel = rows[0] ? `${rows[0].bsns_year} ${rows[0].report_label || rows[0].report_key || ""}`.trim() : "최근 선택 기간";
  const operatingIncomeValues = values(rows, "operating_income");
  const marginValues = rows.map((row) => chartValue(row, "operating_margin")).filter(Number.isFinite);
  const topIncome = topBy(rows, "operating_income");
  const topRoe = topBy(rows, "roe");
  const weakMargin = bottomBy(rows, "operating_margin");
  const estimateRows = rows.filter((row) => isBlank(row.operating_revenue) && !isBlank(row.operating_revenue_estimate));

  $("strategySubtitle").textContent = `${periodLabel} 기준 ${rows.length}개 회사 비교`;
  kpiGrid.append(
    kpiCard("수집률", percent(collected.length, state.analysisRows.length), `${collected.length}/${state.analysisRows.length}행 수집`),
    kpiCard("합산 영업이익", formatMetric(sum(operatingIncomeValues), "operating_income"), `${rows.length}개사 기준`),
    kpiCard("중앙 영업이익", formatMetric(median(operatingIncomeValues), "operating_income"), "극단값 노이즈 완화"),
    kpiCard("평균 영업이익률", formatMetric(avg(marginValues), "operating_margin"), "공식 영업수익 기준"),
    kpiCard("추정 영업수익", `${estimateRows.length}개`, "공식 영업수익 공백 보완"),
    kpiCard("미확보/경고", `${missing}/${state.analysisWarnings.length}`, "행 미확보 / 경고 건수")
  );

  for (const insight of buildInsights(rows, { topIncome, topRoe, weakMargin, estimateRows, missing })) {
    const li = document.createElement("li");
    li.textContent = insight;
    if (isWarningInsight(insight)) li.classList.add("is-warning");
    insightList.appendChild(li);
  }
  renderGroupSummary(rows, groupSummary);
  $("reportButton").disabled = !rows.length;
}

function kpiCard(title, value, note) {
  const card = document.createElement("div");
  card.className = "kpi-card";
  card.innerHTML = `<span>${htmlEscape(title)}</span><strong>${htmlEscape(value)}</strong><small>${htmlEscape(note)}</small>`;
  return card;
}

function buildInsights(rows, context) {
  const insights = [];
  if (context.topIncome) {
    insights.push(`영업이익 1위는 ${context.topIncome.corp_name}이며 ${formatMetric(context.topIncome.operating_income, "operating_income")}입니다.`);
  }
  if (context.topRoe) {
    insights.push(`ROE 상위는 ${context.topRoe.corp_name} ${formatMetric(context.topRoe.roe, "roe")}로 자본 효율성이 돋보입니다.`);
  }
  const weakMargin = context.weakMargin ? numeric(context.weakMargin.operating_margin) : null;
  if (Number.isFinite(weakMargin) && weakMargin < 0.05) {
    insights.push(`${context.weakMargin.corp_name}의 공식 영업이익률은 ${formatMetric(weakMargin, "operating_margin")}로 수익성 점검 대상입니다.`);
  }
  if (context.estimateRows.length) {
    insights.push(`${companyNamesSummary(context.estimateRows)}: 공식 영업수익이 비어 추정 합산을 사용했습니다. 원문 보기로 확인하세요.`);
  }
  if (context.missing > 0) {
    insights.push(`미확보 행 ${context.missing}건은 공시 접수 여부와 XBRL 계정 추출 상태를 확인해야 합니다.`);
  }
  if (!insights.length) insights.push("수집 범위 내에서 큰 결측 없이 비교 가능한 상태입니다.");
  return insights;
}

function renderGroupSummary(rows, container) {
  const groups = new Map();
  for (const row of rows) {
    const group = companyGroup(row.corp_name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  if (!groups.size) {
    container.innerHTML = `<div class="empty-mini">데이터 없음</div>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "mini-table";
  table.innerHTML = `<thead><tr><th>비교군</th><th>회사 수</th><th>영업이익 중앙값</th><th>평균 ROE</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const [group, groupRows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${htmlEscape(group)}</td><td>${groupRows.length}</td><td>${htmlEscape(formatMetric(median(values(groupRows, "operating_income")), "operating_income"))}</td><td>${htmlEscape(formatMetric(avg(values(groupRows, "roe")), "roe"))}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderTrend() {
  const metric = $("trendMetricSelect").value;
  const trendBody = $("trendBody");
  trendBody.innerHTML = "";
  const periods = sortedPeriods(state.analysisRows);
  const setTrendEmpty = (empty) => {
    $("trendPanel").classList.toggle("is-empty", empty);
    trendBody.classList.toggle("is-empty", empty);
  };
  if (periods.length < 2) {
    setTrendEmpty(true);
    trendBody.innerHTML = `<div class="empty-chart">여러 연도나 보고서를 선택하면 추이가 표시됩니다.</div>`;
    $("trendSubtitle").textContent = "여러 연도나 보고서를 선택하면 주요 회사의 흐름을 보여줍니다.";
    return;
  }

  const rowsByCompany = new Map();
  for (const row of state.analysisRows.filter((item) => item.collection_status === "수집 완료")) {
    const value = chartValue(row, metric);
    if (!Number.isFinite(value)) continue;
    if (!rowsByCompany.has(row.corp_name)) rowsByCompany.set(row.corp_name, new Map());
    rowsByCompany.get(row.corp_name).set(periodKey(row), { row, value });
  }

  const series = [...rowsByCompany.entries()]
    .map(([name, periodMap]) => ({
      name,
      values: periods.map((period) => periodMap.get(period.key)?.value ?? null),
      latest: periodMap.get(periods.at(-1).key)?.value ?? null
    }))
    .filter((item) => item.values.filter(Number.isFinite).length >= 2)
    .sort((a, b) => Math.abs(b.latest ?? 0) - Math.abs(a.latest ?? 0))
    .slice(0, 5);

  if (!series.length) {
    setTrendEmpty(true);
    trendBody.innerHTML = `<div class="empty-chart">추이 계산 가능한 회사가 없습니다.</div>`;
    $("trendSubtitle").textContent = "동일 회사가 둘 이상의 기간에 수집되어야 합니다.";
    return;
  }

  setTrendEmpty(false);
  $("trendSubtitle").textContent = `${displayLabel(metric)} 기준 주요 ${series.length}개 회사`;
  trendBody.appendChild(trendSvg(series, periods, metric));
}

function trendSvg(series, periods, metric) {
  const width = 820;
  const height = 240;
  const pad = { top: 22, right: 24, bottom: 46, left: 80 };
  const valuesFlat = series.flatMap((item) => item.values).filter(Number.isFinite);
  const minValue = Math.min(...valuesFlat, 0);
  const maxValue = Math.max(...valuesFlat, 1);
  const range = maxValue - minValue || 1;
  const colors = ["#3fb7a4", "#d34bc6", "#e3bd58", "#7aa7ff", "#ff8f70"];
  const xFor = (index) => pad.left + (index * (width - pad.left - pad.right)) / Math.max(periods.length - 1, 1);
  const yFor = (value) => pad.top + ((maxValue - value) * (height - pad.top - pad.bottom)) / range;

  const wrap = document.createElement("div");
  wrap.className = "trend-wrap";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${displayLabel(metric)} 추이`);

  svg.appendChild(svgLine(pad.left, yFor(0), width - pad.right, yFor(0), "trend-axis"));
  periods.forEach((period, index) => {
    const x = xFor(index);
    svg.appendChild(svgText(x, height - 16, period.label, "trend-label", "middle"));
  });
  svg.appendChild(svgText(8, yFor(maxValue), formatMetric(maxValue, metric), "trend-scale", "start"));
  svg.appendChild(svgText(8, yFor(minValue), formatMetric(minValue, metric), "trend-scale", "start"));

  series.forEach((item, seriesIndex) => {
    const points = item.values
      .map((value, index) => (Number.isFinite(value) ? `${xFor(index)},${yFor(value)}` : null))
      .filter(Boolean)
      .join(" ");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", colors[seriesIndex % colors.length]);
    polyline.setAttribute("stroke-width", "3");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    svg.appendChild(polyline);
    item.values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", xFor(index));
      circle.setAttribute("cy", yFor(value));
      circle.setAttribute("r", "4");
      circle.setAttribute("fill", colors[seriesIndex % colors.length]);
      svg.appendChild(circle);
    });
  });

  const legend = document.createElement("div");
  legend.className = "trend-legend";
  series.forEach((item, index) => {
    const chip = document.createElement("span");
    chip.innerHTML = `<i style="background:${colors[index % colors.length]}"></i>${htmlEscape(item.name)}`;
    legend.appendChild(chip);
  });
  wrap.append(svg, legend);
  return wrap;
}

function svgLine(x1, y1, x2, y2, className) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("class", className);
  return line;
}

function svgText(x, y, text, className, anchor) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
  node.setAttribute("x", x);
  node.setAttribute("y", y);
  node.setAttribute("class", className);
  node.setAttribute("text-anchor", anchor);
  node.textContent = text;
  return node;
}

function chartValue(row, metric) {
  if (metric === "operating_revenue") {
    const official = numeric(row.operating_revenue);
    return Number.isFinite(official) ? official : numeric(row.operating_revenue_estimate);
  }
  return numeric(row[metric]);
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestComparableRows() {
  const completed = state.analysisRows.filter((row) => row.collection_status === "수집 완료");
  if (!completed.length) return [];
  const periods = sortedPeriods(completed);
  const latest = periods.at(-1)?.key;
  return completed.filter((row) => periodKey(row) === latest);
}

function sortedPeriods(rows) {
  const periods = new Map();
  for (const row of rows) {
    const key = periodKey(row);
    if (!periods.has(key)) {
      periods.set(key, {
        key,
        label: periodLabel(row),
        sort: periodSortValue(row)
      });
    }
  }
  return [...periods.values()].sort((a, b) => a.sort - b.sort);
}

function periodKey(row) {
  return `${row.bsns_year || ""}|${reportOrder(row.report_key || row.reprt_code || row.report_label)}`;
}

function periodSortValue(row) {
  return Number(row.bsns_year || 0) * 10 + reportOrder(row.report_key || row.reprt_code || row.report_label);
}

function periodLabel(row) {
  const year = row.bsns_year || "";
  const order = reportOrder(row.report_key || row.reprt_code || row.report_label);
  const suffix = { 1: "1Q", 2: "2Q", 3: "3Q", 4: "FY" }[order] || row.report_label || "";
  return `${year} ${suffix}`.trim();
}

function reportOrder(value) {
  const text = String(value || "");
  if (text === "q1" || text === "11013" || text.includes("1분기")) return 1;
  if (text === "half" || text === "11012" || text.includes("반기")) return 2;
  if (text === "q3" || text === "11014" || text.includes("3분기")) return 3;
  if (text === "annual" || text === "11011" || text.includes("사업")) return 4;
  return 0;
}

function values(rows, metric) {
  return rows.map((row) => chartValue(row, metric)).filter(Number.isFinite);
}

function sum(numbers) {
  return numbers.reduce((total, value) => total + value, 0);
}

function avg(numbers) {
  return numbers.length ? sum(numbers) / numbers.length : null;
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function topBy(rows, metric) {
  return rows
    .filter((row) => Number.isFinite(chartValue(row, metric)))
    .sort((a, b) => chartValue(b, metric) - chartValue(a, metric))[0] || null;
}

function bottomBy(rows, metric) {
  return rows
    .filter((row) => Number.isFinite(chartValue(row, metric)))
    .sort((a, b) => chartValue(a, metric) - chartValue(b, metric))[0] || null;
}

function percent(numerator, denominator) {
  if (!denominator) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatMetric(value, metric) {
  return Number.isFinite(value) ? formatCell(value, metric) : "-";
}

function companyNamesSummary(rows, visibleCount = 3) {
  const names = rows.map((row) => row.corp_name).filter(Boolean);
  if (!names.length) return `${rows.length}개 회사`;
  const visible = names.slice(0, visibleCount).join(", ");
  const extra = names.length - visibleCount;
  return extra > 0 ? `${visible} 외 ${extra}개` : visible;
}

function isWarningInsight(text) {
  return text.includes("추정") || text.includes("미확보") || text.includes("확인");
}

function isBlank(value) {
  return value === null || value === undefined || value === "";
}

function emptyListItem(text) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

function companyGroup(name) {
  const company = String(name || "");
  if (["미래에셋증권", "NH투자증권", "한국투자증권", "삼성증권", "KB증권", "신한투자증권", "하나증권", "메리츠증권"].includes(company)) {
    return "대형 종합";
  }
  if (["키움증권", "토스증권", "카카오페이증권"].includes(company)) {
    return "리테일/디지털";
  }
  if (["대신증권", "한화투자증권", "유안타증권", "DB금융투자", "유진투자증권", "교보증권", "신영증권", "현대차증권", "SK증권", "LS증권", "한양증권", "다올투자증권"].includes(company)) {
    return "중형 종합";
  }
  return "기타/비상장";
}

function downloadCurrentFile() {
  const rows = currentRows();
  const columns = currentColumns().filter((column) => column !== "pdf");
  if (!rows.length) return;
  const format = $("exportFormatSelect").value;
  const name = `${state.activeView}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
  const table = rows.map((row) => Object.fromEntries(columns.map((column) => [displayLabel(column), formatFullCell(row[column], column)])));

  if (format === "json") {
    downloadBlob(`${name}.json`, JSON.stringify(table, null, 2), "application/json;charset=utf-8");
    return;
  }
  if (format === "md") {
    downloadBlob(`${name}.md`, markdownTable(table), "text/markdown;charset=utf-8");
    return;
  }
  if (format === "html" || format === "xls") {
    const html = htmlTable(table);
    const extension = format === "xls" ? "xls" : "html";
    const type = format === "xls" ? "application/vnd.ms-excel;charset=utf-8" : "text/html;charset=utf-8";
    downloadBlob(`${name}.${extension}`, html, type);
    return;
  }

  const delimiter = format === "tsv" ? "\t" : ",";
  const extension = format === "tsv" ? "tsv" : "csv";
  const type = format === "tsv" ? "text/tab-separated-values;charset=utf-8" : "text/csv;charset=utf-8";
  downloadBlob(`${name}.${extension}`, delimitedTable(table, delimiter), type);
}

function downloadStrategyReport() {
  const report = buildStrategyReport();
  const name = `strategy_report_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`;
  downloadBlob(name, report, "text/markdown;charset=utf-8");
}

function buildStrategyReport() {
  const rows = latestComparableRows();
  const collected = state.analysisRows.filter((row) => row.collection_status === "수집 완료");
  const period = rows[0] ? periodLabel(rows[0]) : "선택 기간";
  const topIncome = topBy(rows, "operating_income");
  const topRoe = topBy(rows, "roe");
  const weakMargin = bottomBy(rows, "operating_margin");
  const estimateRows = rows.filter((row) => isBlank(row.operating_revenue) && !isBlank(row.operating_revenue_estimate));
  const lines = [
    `# 증권사 섹터 전략 리포트`,
    ``,
    `- 생성시각: ${new Date().toLocaleString("ko-KR")}`,
    `- 기준기간: ${period}`,
    `- 수집률: ${percent(collected.length, state.analysisRows.length)} (${collected.length}/${state.analysisRows.length})`,
    `- 원천 행 수: ${new Intl.NumberFormat("ko-KR").format(state.analysisRawCount || 0)}`,
    `- 경고 건수: ${state.analysisWarnings.length}`,
    ``,
    `## 핵심 판단`,
    ``
  ];
  for (const insight of buildInsights(rows, { topIncome, topRoe, weakMargin, estimateRows, missing: state.analysisRows.length - collected.length })) {
    lines.push(`- ${insight}`);
  }
  lines.push(``, `## 주요 회사`, ``);
  lines.push(markdownMetricTable(rows.slice().sort((a, b) => chartValue(b, "operating_income") - chartValue(a, "operating_income")).slice(0, 10)));
  lines.push(``, `## 비교군 요약`, ``);
  lines.push(markdownGroupTable(rows));
  lines.push(``, `## 데이터 품질 메모`, ``);
  lines.push(`- 공식 영업수익 공백 후 추정 합산 사용: ${estimateRows.length}개`);
  lines.push(`- 원문 PDF 확인 가능 행: ${rows.filter((row) => row.rcept_no).length}개`);
  if (state.analysisWarnings.length) {
    lines.push(`- 최근 경고: ${state.analysisWarnings.slice(0, 5).join("; ")}`);
  } else {
    lines.push(`- 경고 없음`);
  }
  return lines.join("\n");
}

function markdownMetricTable(rows) {
  const headers = ["순위", "회사", "영업이익", "세전이익", "당기순이익", "ROE", "원문"];
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  rows.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${markdownEscape(row.corp_name)} | ${formatMetric(chartValue(row, "operating_income"), "operating_income")} | ${formatMetric(chartValue(row, "pretax_income"), "pretax_income")} | ${formatMetric(chartValue(row, "net_income"), "net_income")} | ${formatMetric(chartValue(row, "roe"), "roe")} | ${row.rcept_no || ""} |`);
  });
  return lines.join("\n");
}

function markdownGroupTable(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = companyGroup(row.corp_name);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  const lines = [`| 비교군 | 회사 수 | 영업이익 중앙값 | 평균 ROE |`, `| --- | --- | --- | --- |`];
  for (const [group, groupRows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${group} | ${groupRows.length} | ${formatMetric(median(values(groupRows, "operating_income")), "operating_income")} | ${formatMetric(avg(values(groupRows, "roe")), "roe")} |`);
  }
  return lines.join("\n");
}

function delimitedTable(rows, delimiter) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map((value) => cellEscape(value, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(headers.map((header) => cellEscape(row[header], delimiter)).join(delimiter));
  }
  return `\ufeff${lines.join("\n")}`;
}

function markdownTable(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [
    `| ${headers.map(markdownEscape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows) {
    lines.push(`| ${headers.map((header) => markdownEscape(row[header] ?? "")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function htmlTable(rows) {
  if (!rows.length) return "<table></table>";
  const headers = Object.keys(rows[0]);
  const head = `<tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr>`;
  const body = rows.map((row) => `<tr>${headers.map((header) => `<td>${htmlEscape(row[header] ?? "")}</td>`).join("")}</tr>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><table>${head}${body}</table>`;
}

function downloadBlob(fileName, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, fileName);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadUrl(url, fileName = "") {
  const anchor = document.createElement("a");
  anchor.href = url;
  if (fileName) anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function apiGet(path) {
  const response = await fetch(path);
  return parseJsonResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseJsonResponse(response);
}

async function parseJsonResponse(response) {
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function parseYears(value) {
  return value
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item));
}

function selectedReports() {
  return [...document.querySelectorAll('input[name="report"]:checked')].map((input) => input.value);
}

function switchWorkspace(workspace) {
  state.activeWorkspace = workspace === "data" ? "data" : "analysis";
  document.querySelectorAll(".workspace-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.workspace === state.activeWorkspace);
  });
  $("analysisWorkspace").classList.toggle("is-active", state.activeWorkspace === "analysis");
  $("dataWorkspace").classList.toggle("is-active", state.activeWorkspace === "data");
}

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("analysisView").classList.toggle("is-active", view === "analysis");
  $("filingsView").classList.toggle("is-active", view === "filings");
  $("exportButton").disabled = !currentRows().length;
  updateDataSubtitle();
}

function currentRows() {
  return state.activeView === "analysis" ? state.analysisRows : state.filingRows;
}

function currentColumns() {
  return state.activeView === "analysis" ? state.analysisColumns : state.filingColumns;
}

function updateDataSubtitle() {
  const rows = currentRows();
  const name = state.activeView === "analysis" ? "재무 분석 데이터" : "공시 조회 데이터";
  const count = new Intl.NumberFormat("ko-KR").format(rows.length);
  $("dataSubtitle").textContent = `${name} ${count}행을 확인하고 파일로 변환합니다.`;
}

function setBusy(busy) {
  $("analyzeButton").disabled = busy;
  $("filingsButton").disabled = busy;
  $("exportButton").disabled = busy || !currentRows().length;
  $("reportButton").disabled = busy || !latestComparableRows().length;
  document.querySelector(".status-line")?.classList.toggle("is-busy", busy);
}

function setStatus(message, isError = false) {
  $("statusText").textContent = message;
  document.querySelector(".status-line")?.classList.toggle("is-error", isError);
}

function displayLabel(column) {
  return state.labels[column] || DEFAULT_LABELS[column] || column;
}

function sectorLabel(name) {
  if (name === "securities") return "증권사 전체";
  if (name === "securities_listed") return "상장 증권사";
  return name;
}

function formatCell(value, column, options = {}) {
  if (value === null || value === undefined || value === "") return "";
  if (column === "fs_div") return FS_DIV_LABELS[value] || String(value);
  if (column === "rcept_dt") return formatDate(value);
  if (typeof value === "number") {
    if (isRatioColumn(column)) return `${(value * 100).toFixed(1)}%`;
    if (column === "rank_operating_income") return String(value);
    if (options.compactAmounts !== false && AMOUNT_COLUMNS.has(column)) return formatAmountCompact(value);
    return new Intl.NumberFormat("ko-KR").format(value);
  }
  return String(value);
}

function formatFullCell(value, column) {
  return formatCell(value, column, { compactAmounts: false });
}

function formatAmountCompact(value) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) {
    const digits = abs >= 10_000_000_000_000 ? 1 : 2;
    return `${trimFixed(value / 1_000_000_000_000, digits)}조`;
  }
  if (abs >= 100_000_000) {
    return `${new Intl.NumberFormat("ko-KR").format(Math.round(value / 100_000_000))}억원`;
  }
  return new Intl.NumberFormat("ko-KR").format(value);
}

function trimFixed(value, digits) {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
}

function isRatioColumn(column) {
  return column.includes("margin") || column.includes("yoy") || column === "roe" || column === "debt_ratio";
}

function cellEscape(value, delimiter) {
  const text = String(value ?? "");
  const needsQuote = delimiter === "," ? /[",\n\r]/.test(text) : /[\t\n\r]/.test(text);
  return needsQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeFileName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
}
