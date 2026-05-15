const state = {
  labels: {},
  sectors: [],
  analysisRows: [],
  analysisColumns: [],
  filingRows: [],
  filingColumns: [],
  activeView: "analysis"
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
  setStatus("대기 중");
}

function bindEvents() {
  $("analyzeButton").addEventListener("click", runAnalysis);
  $("filingsButton").addEventListener("click", listFilings);
  $("downloadCsvButton").addEventListener("click", downloadCurrentCsv);
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
    const batchSize = analysisBatchSize(payload);
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

function analysisBatchSize(payload) {
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
        td.appendChild(pdfButton(row));
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
  $("downloadCsvButton").disabled = !currentRows().length;
}

function pdfButton(row) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-button";
  button.textContent = "PDF";
  button.disabled = !row.rcept_no;
  button.addEventListener("click", () => downloadPdf(row));
  return button;
}

function statusChip(value) {
  const span = document.createElement("span");
  span.className = `status-chip ${value === "수집 완료" ? "" : "missing"}`;
  span.textContent = value || "미확보";
  return span;
}

function downloadPdf(row) {
  const label = row.report_label || row.report_nm || "report";
  const fileName = sanitizeFileName(`${row.rcept_dt || ""}_${row.corp_name || ""}_${label}_${row.rcept_no}.pdf`);
  const url = `/api/pdf?rceptNo=${encodeURIComponent(row.rcept_no)}&fileName=${encodeURIComponent(fileName)}`;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function downloadCurrentCsv() {
  const rows = currentRows();
  const columns = currentColumns();
  if (!rows.length) return;
  const header = columns.filter((column) => column !== "pdf").map((column) => state.labels[column] || column);
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(columns.filter((column) => column !== "pdf").map((column) => csvEscape(row[column] ?? "")).join(","));
  }
  const blob = new Blob(["\ufeff", lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${state.activeView}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  anchor.remove();
}

async function apiGet(path) {
  const response = await fetch(path, { headers: apiHeaders() });
  return parseJsonResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...apiHeaders() },
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

function apiHeaders() {
  const key = $("apiKeyInput").value.trim();
  return key ? { "x-dart-api-key": key } : {};
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
  $("downloadCsvButton").disabled = !currentRows().length;
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
  $("downloadCsvButton").disabled = busy || !currentRows().length;
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

function csvEscape(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sanitizeFileName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
}
