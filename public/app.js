const state = {
  labels: {},
  sectors: [],
  analysisRows: [],
  analysisColumns: [],
  filingRows: [],
  filingColumns: [],
  activeView: "analysis",
  pdfDownloadUrl: "",
  lastFocusedElement: null
};

const $ = (id) => document.getElementById(id);

init().catch((error) => setStatus(error.message, true));

async function init() {
  bindEvents();
  const config = await apiGet("/api/config");
  state.labels = config.labels || {};
  state.sectors = config.sectors || [];
  populateSectors(state.sectors);
  state.analysisColumns = config.metricColumns || [];
  state.filingColumns = config.filingColumns || [];
  renderTable($("analysisTable"), [], state.analysisColumns);
  renderTable($("filingsTable"), [], state.filingColumns);
  renderChart();
  setStatus("대기 중");
}

function bindEvents() {
  $("analyzeButton").addEventListener("click", runAnalysis);
  $("filingsButton").addEventListener("click", listFilings);
  $("exportButton").addEventListener("click", downloadCurrentFile);
  $("chartMetricSelect").addEventListener("change", renderChart);
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
}

function populateSectors(sectors) {
  const select = $("sectorSelect");
  select.innerHTML = "";
  for (const sector of sectors) {
    const option = document.createElement("option");
    option.value = sector.name;
    option.textContent = `${sector.name} (${sector.companyCount})`;
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
    renderTable($("analysisTable"), state.analysisRows, state.analysisColumns);
    renderChart();
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
    $("summaryLine").textContent = `공시 ${state.filingRows.length}건 | ${result.start}-${result.end}`;
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
    th.textContent = state.labels[column] || column;
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
      if (column === "pdf") {
        td.className = "document-column";
        td.appendChild(documentActions(row));
      } else if (column === "collection_status") {
        td.appendChild(statusChip(row[column]));
      } else {
        td.textContent = formatCell(row[column], column);
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
}

function documentActions(row) {
  const wrap = document.createElement("div");
  wrap.className = "doc-actions";
  const viewButton = document.createElement("button");
  viewButton.type = "button";
  viewButton.textContent = "보기";
  viewButton.disabled = !row.rcept_no;
  viewButton.addEventListener("click", () => openPdfViewer(row));

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "PDF";
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

function openPdfViewer(row) {
  const { inlineUrl, downloadUrl, fileName } = pdfUrls(row);
  state.pdfDownloadUrl = downloadUrl;
  state.lastFocusedElement = document.activeElement;
  $("pdfModalTitle").textContent = row.corp_name ? `${row.corp_name} 원문 보고서` : "원문 보고서";
  $("pdfModalMeta").textContent = [row.report_label || row.report_nm, row.rcept_dt, row.rcept_no].filter(Boolean).join(" · ");
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

function renderChart() {
  const metric = $("chartMetricSelect").value;
  const rows = state.analysisRows
    .filter((row) => row.collection_status === "수집 완료")
    .map((row) => ({ row, value: chartValue(row, metric) }))
    .filter((item) => Number.isFinite(item.value));
  const chartBody = $("chartBody");
  chartBody.innerHTML = "";
  if (!rows.length) {
    chartBody.innerHTML = `<div class="empty-chart">데이터 없음</div>`;
    $("chartSubtitle").textContent = "분석 결과가 나오면 회사별 지표를 비교합니다.";
    return;
  }

  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const visibleRows = rows.slice(0, 12);
  const maxAbs = Math.max(...visibleRows.map((item) => Math.abs(item.value)), 1);
  $("chartSubtitle").textContent = `${state.labels[metric] || metric} 기준 상위 ${visibleRows.length}개`;

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

function chartValue(row, metric) {
  if (metric === "operating_revenue") {
    return numeric(row.operating_revenue ?? row.operating_revenue_estimate);
  }
  return numeric(row[metric]);
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function downloadCurrentFile() {
  const rows = currentRows();
  const columns = currentColumns().filter((column) => column !== "pdf");
  if (!rows.length) return;
  const format = $("exportFormatSelect").value;
  const name = `${state.activeView}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
  const table = rows.map((row) => Object.fromEntries(columns.map((column) => [state.labels[column] || column, row[column] ?? ""])));

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

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $("analysisView").classList.toggle("is-active", view === "analysis");
  $("filingsView").classList.toggle("is-active", view === "filings");
  $("exportButton").disabled = !currentRows().length;
}

function currentRows() {
  return state.activeView === "analysis" ? state.analysisRows : state.filingRows;
}

function currentColumns() {
  return state.activeView === "analysis" ? state.analysisColumns : state.filingColumns;
}

function setBusy(busy) {
  $("analyzeButton").disabled = busy;
  $("filingsButton").disabled = busy;
  $("exportButton").disabled = busy || !currentRows().length;
}

function setStatus(message, isError = false) {
  $("statusText").textContent = message;
  $("statusText").style.color = isError ? "var(--danger)" : "var(--muted)";
}

function formatCell(value, column) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    if (isRatioColumn(column)) return `${(value * 100).toFixed(1)}%`;
    if (column === "rank_operating_income") return String(value);
    return new Intl.NumberFormat("ko-KR").format(value);
  }
  return String(value);
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
