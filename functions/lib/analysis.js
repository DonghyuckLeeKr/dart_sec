import { COLUMN_LABELS, FILING_COLUMNS, METRIC_COLUMNS, REPORT_CODE_TO_KEY, REPORT_KINDS } from "./constants.js";
import { financialStatement, searchDisclosures, xbrlDocument } from "./dart.js";
import { resolveCompanies, sectorNames, SECTORS } from "./sectors.js";
import { parseXbrlFinancialStatement } from "./xbrl.js";

const PERIODIC_REPORT_WORDS = ["사업보고서", "분기보고서", "반기보고서"];

const METRIC_ALIASES = {
  operating_revenue: {
    accountIds: new Set(["ifrs-full_Revenue", "dart_OperatingRevenue"]),
    names: ["영업수익", "매출액", "수익(매출액)", "영업수익(매출액)"]
  },
  operating_income: {
    accountIds: new Set(["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"]),
    names: ["영업이익", "영업이익(손실)", "영업손익", "영업활동손익"]
  },
  pretax_income: {
    accountIds: new Set(["ifrs-full_ProfitLossBeforeTax", "ifrs-full_ProfitLossFromContinuingOperationsBeforeTax"]),
    names: ["세전이익", "법인세비용차감전순이익", "법인세비용차감전순이익(손실)", "법인세차감전순이익", "법인세차감전순이익(손실)", "분기법인세비용차감전순이익", "반기법인세비용차감전순이익"]
  },
  net_income: {
    accountIds: new Set(["ifrs-full_ProfitLoss"]),
    names: ["당기순이익", "당기순이익(손실)", "분기순이익", "반기순이익", "연결당기순이익"]
  },
  assets: {
    accountIds: new Set(["ifrs-full_Assets"]),
    names: ["자산총계", "총자산"]
  },
  liabilities: {
    accountIds: new Set(["ifrs-full_Liabilities"]),
    names: ["부채총계", "총부채"]
  },
  equity: {
    accountIds: new Set(["ifrs-full_Equity"]),
    names: ["자본총계", "총자본", "자기자본", "자본총계(자기자본)"]
  }
};

const REVENUE_COMPONENTS = [
  { label: "수수료수익", ids: ["ifrs-full_FeeAndCommissionIncome"], names: ["수수료수익", "FeeAndCommissionIncome"] },
  { label: "이자수익", ids: ["ifrs-full_RevenueFromInterest"], names: ["이자수익", "RevenueFromInterest"] },
  { label: "배당수익", ids: ["ifrs-full_RevenueFromDividends"], names: ["배당수익", "RevenueFromDividends"] },
  {
    label: "금융상품관련이익/순손익",
    ids: [
      "ifrs-full_GainFromFinancialInstruments",
      "ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
      "ifrs-full_GainFromFinancialInstrumentsAtAmortisedCost",
      "ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome",
      "ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
      "ifrs-full_GainLossFromFinancialInstrumentsAtAmortisedCost",
      "ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome"
    ],
    names: ["금융상품관련이익", "금융상품관련순손익", "당기손익-공정가치측정금융상품관련순손익", "상각후원가측정금융상품관련순손익", "기타포괄손익-공정가치측정금융자산관련순손익"]
  },
  { label: "외환거래이익/손익", ids: ["ifrs-full_ForeignExchangeGain", "ifrs-full_GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss"], names: ["외환거래이익", "외환거래손익"] },
  { label: "기타영업수익/손익", ids: ["ifrs-full_OtherOperatingIncome", "dart_OtherOperatingIncome", "ifrs-full_OtherOperatingIncomeExpense", "ifrs-full_MiscellaneousOtherOperatingIncome"], names: ["기타영업수익", "기타의영업손익"] }
];

export function configPayload() {
  return {
    sectors: sectorNames().map((name) => ({ name, description: SECTORS[name].description, companyCount: SECTORS[name].companies.length })),
    reports: REPORT_KINDS,
    labels: COLUMN_LABELS,
    metricColumns: METRIC_COLUMNS,
    filingColumns: FILING_COLUMNS
  };
}

export async function listSectorFilings(apiKey, { sector = "securities", days = 30, limit = 0, final = true }) {
  const companies = resolveCompanies(sector, limit);
  const end = compactDate(new Date());
  const start = compactDate(addDays(new Date(), -Number(days || 30)));
  const allRows = [];
  await mapLimit(companies, 4, async (company) => {
    const filings = await searchDisclosures(apiKey, {
      corpCode: company.corp_code,
      bgnDe: start,
      endDe: end,
      final,
      pblntfTy: "A"
    });
    for (const filing of filterPeriodicFilings(filings)) {
      allRows.push({ ...filing, corp_name: company.name, stock_code: company.stock_code || filing.stock_code });
    }
  });
  allRows.sort((a, b) => `${b.rcept_dt}${b.rcept_no}`.localeCompare(`${a.rcept_dt}${a.rcept_no}`));
  return { rows: allRows, columns: FILING_COLUMNS, start, end, companyCount: companies.length };
}

export async function analyzeSector(apiKey, payload) {
  const sector = payload.sector || "securities";
  const companies = resolveCompanies(sector, payload.limit, payload.offset);
  const years = normalizeYears(payload.years);
  const reports = normalizeReports(payload.reports);
  const fsDiv = payload.fsDiv || "CFS";
  const fallbackOfs = payload.fallbackOfs !== false;
  const xbrlFallback = payload.xbrlFallback !== false;
  const final = payload.final !== false;
  const concurrency = Math.min(Math.max(Number(payload.concurrency || 4), 1), 8);

  const tasks = [];
  for (const company of companies) {
    for (const year of years) {
      for (const reportKey of reports) {
        tasks.push({ company, year, reportKey });
      }
    }
  }

  const rawRows = [];
  const warnings = [];
  const filingIndex = new Map();
  await mapLimit(tasks, concurrency, async ({ company, year, reportKey }) => {
    const { rows, warnings: taskWarnings, filing } = await collectOne(apiKey, {
      company,
      year,
      reportKey,
      fsDiv,
      fallbackOfs,
      xbrlFallback,
      final
    });
    rawRows.push(...rows);
    warnings.push(...taskWarnings);
    if (filing) {
      filingIndex.set(filingKey(company.corp_code, year, reportKey), filing);
    }
  });

  const metrics = buildMetrics(rawRows);
  const coverage = buildCoverageRows(companies, metrics, years, reports, warnings, filingIndex);
  return {
    sector,
    companyCount: companies.length,
    offset: Number(payload.offset || 0),
    years,
    reports,
    fsDiv,
    rows: coverage,
    metrics,
    rawCount: rawRows.length,
    warnings,
    columns: METRIC_COLUMNS
  };
}

async function collectOne(apiKey, { company, year, reportKey, fsDiv, fallbackOfs, xbrlFallback, final }) {
  const kind = REPORT_KINDS[reportKey];
  const warnings = [];
  const filing = await findPeriodicFiling(apiKey, { corpCode: company.corp_code, bsnsYear: year, reportKey, final });
  const fetched = await fetchStatementWithFallback(apiKey, { company, year, reportCode: kind.code, fsDiv, fallbackOfs });
  let rows = fetched.rows;
  let usedFsDiv = fetched.usedFsDiv;
  let dataSource = "OpenDART 재무제표 API";
  if (fetched.message) warnings.push(fetched.message);

  if (!rows.length && xbrlFallback) {
    if (!filing) {
      warnings.push(`${company.name} ${year}/${kind.label}: XBRL fallback용 접수번호 없음`);
    } else {
      try {
        const zip = await xbrlDocument(apiKey, { rceptNo: filing.rcept_no, reprtCode: kind.code });
        const parsed = parseXbrlFinancialStatement(zip, {
          corpCode: company.corp_code,
          corpName: company.name,
          stockCode: company.stock_code,
          bsnsYear: year,
          reprtCode: kind.code,
          fsDiv,
          fallbackOfs,
          rceptNo: filing.rcept_no
        });
        rows = parsed.rows;
        usedFsDiv = parsed.usedFsDiv;
        if (rows.length) {
          dataSource = "XBRL 원문";
          warnings.push(`${company.name} ${year}/${kind.label}: API 재무제표 없음, XBRL 원문 사용(${filing.rcept_no})`);
        } else {
          warnings.push(`${company.name} ${year}/${kind.label}: XBRL에서 핵심 계정 추출 실패(${filing.rcept_no})`);
        }
      } catch (error) {
        warnings.push(`${company.name} ${year}/${kind.label}: XBRL fallback 실패(${error.message})`);
      }
    }
  }

  return {
    filing,
    warnings,
    rows: rows.map((row) => ({
      ...row,
      corp_code: row.corp_code || company.corp_code,
      corp_name: row.corp_name || company.name,
      stock_code: row.stock_code || company.stock_code,
      sector_corp_name: company.name,
      sector_stock_code: company.stock_code,
      requested_fs_div: fsDiv,
      used_fs_div: usedFsDiv,
      data_source: row.data_source || dataSource,
      report_key: reportKey,
      report_label: kind.label,
      rcept_no: row.rcept_no || filing?.rcept_no || "",
      rcept_dt: row.rcept_dt || filing?.rcept_dt || ""
    }))
  };
}

async function fetchStatementWithFallback(apiKey, { company, year, reportCode, fsDiv, fallbackOfs }) {
  try {
    const rows = await financialStatement(apiKey, { corpCode: company.corp_code, bsnsYear: year, reprtCode: reportCode, fsDiv });
    if (rows.length) return { rows, usedFsDiv: fsDiv, message: "" };
  } catch (error) {
    if (!fallbackOfs || fsDiv === "OFS") return { rows: [], usedFsDiv: fsDiv, message: `${company.name} ${year}/${reportCode}/${fsDiv}: ${error.message}` };
  }

  if (fallbackOfs && fsDiv !== "OFS") {
    try {
      const rows = await financialStatement(apiKey, { corpCode: company.corp_code, bsnsYear: year, reprtCode: reportCode, fsDiv: "OFS" });
      if (rows.length) return { rows, usedFsDiv: "OFS", message: `${company.name} ${year}/${reportCode}: CFS 없음, OFS 사용` };
    } catch (error) {
      return { rows: [], usedFsDiv: "OFS", message: `${company.name} ${year}/${reportCode}/OFS: ${error.message}` };
    }
  }
  return { rows: [], usedFsDiv: fsDiv, message: `${company.name} ${year}/${reportCode}/${fsDiv}: 데이터 없음` };
}

export async function findPeriodicFiling(apiKey, { corpCode, bsnsYear, reportKey, final = true }) {
  const kind = REPORT_KINDS[reportKey];
  const today = new Date();
  const start = `${bsnsYear}0101`;
  let endDate = new Date(bsnsYear + 1, 11, 31);
  if (reportKey === "annual") endDate = new Date(bsnsYear + 1, 5, 30);
  if (endDate > today) endDate = today;
  const filings = await searchDisclosures(apiKey, {
    corpCode,
    bgnDe: start,
    endDe: compactDate(endDate),
    final,
    pblntfTy: "A"
  });
  const periodic = filterPeriodicFilings(filings);
  const exact = periodic.filter((filing) => inferReportFromName(filing.report_nm) === reportKey && filing.report_nm.includes(`(${bsnsYear}.${kind.periodMonth})`));
  if (exact.length) return latestFiling(exact);
  const fallback = periodic.filter((filing) => inferReportFromName(filing.report_nm) === reportKey && inferYearFromReport(filing.report_nm, filing.rcept_dt) === bsnsYear);
  return fallback.length ? latestFiling(fallback) : null;
}

function buildMetrics(rawRows) {
  const grouped = new Map();
  for (const row of rawRows) {
    const key = [row.corp_code || "", row.bsns_year || "", row.reprt_code || "", row.used_fs_div || ""].join("|");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const metrics = [];
  for (const rows of grouped.values()) {
    const first = rows[0];
    const values = {};
    const basis = {};
    const accounts = {};
    for (const metricName of Object.keys(METRIC_ALIASES)) {
      const found = findMetric(rows, metricName, first.reprt_code);
      values[metricName] = found.value;
      basis[`${metricName}_basis`] = found.basis;
      accounts[`${metricName}_account`] = found.account;
    }
    const estimate = values.operating_revenue == null ? deriveOperatingRevenue(rows, first.reprt_code) : { value: null, basis: "", account: "" };
    metrics.push({
      corp_code: first.corp_code || "",
      corp_name: first.sector_corp_name || first.corp_name || "",
      stock_code: first.stock_code || first.sector_stock_code || "",
      bsns_year: String(first.bsns_year || ""),
      reprt_code: first.reprt_code || "",
      report_key: REPORT_CODE_TO_KEY[first.reprt_code] || first.report_key || "",
      report_label: first.report_label || "",
      fs_div: first.used_fs_div || "",
      ...values,
      operating_revenue_estimate: estimate.value,
      operating_margin: safeRatio(values.operating_income, values.operating_revenue),
      operating_margin_estimate: safeRatio(values.operating_income, estimate.value),
      net_margin: safeRatio(values.net_income, values.operating_revenue),
      roe: safeRatio(values.net_income, values.equity),
      debt_ratio: safeRatio(values.liabilities, values.equity),
      ...basis,
      operating_revenue_estimate_basis: estimate.basis,
      ...accounts,
      operating_revenue_estimate_account: estimate.account,
      rcept_no: first.rcept_no || "",
      rcept_dt: first.rcept_dt || "",
      currency: first.currency || "",
      data_source: first.data_source || "",
      collection_status: "수집 완료",
      failure_reason: ""
    });
  }
  attachYoy(metrics, "operating_income");
  attachYoy(metrics, "pretax_income");
  attachYoy(metrics, "net_income");
  attachRank(metrics);
  metrics.sort((a, b) => `${a.bsns_year}${a.reprt_code}${String(a.rank_operating_income || 9999).padStart(4, "0")}`.localeCompare(`${b.bsns_year}${b.reprt_code}${String(b.rank_operating_income || 9999).padStart(4, "0")}`));
  return metrics;
}

function buildCoverageRows(companies, metrics, years, reports, warnings, filingIndex) {
  const indexed = new Map();
  for (const row of metrics) {
    const key = filingKey(row.corp_code, row.bsns_year, row.report_key);
    if (!indexed.has(key)) indexed.set(key, []);
    indexed.get(key).push(row);
  }
  const rows = [];
  for (const year of years) {
    for (const reportKey of reports) {
      const kind = REPORT_KINDS[reportKey];
      for (const company of companies) {
        const key = filingKey(company.corp_code, year, reportKey);
        const found = indexed.get(key);
        if (found?.length) {
          rows.push(...found);
          continue;
        }
        const filing = filingIndex.get(key);
        rows.push({
          corp_code: company.corp_code,
          corp_name: company.name,
          stock_code: company.stock_code,
          bsns_year: String(year),
          reprt_code: kind.code,
          report_key: reportKey,
          report_label: kind.label,
          fs_div: "",
          data_source: "",
          collection_status: "미확보",
          failure_reason: missingReason(company.name, year, kind.label, warnings),
          rcept_no: filing?.rcept_no || "",
          rcept_dt: filing?.rcept_dt || ""
        });
      }
    }
  }
  return rows;
}

function findMetric(rows, metricName, reportCode) {
  const aliases = METRIC_ALIASES[metricName];
  const exactNames = new Set(aliases.names.map(cleanAccountName));
  const candidates = [];
  for (const row of rows) {
    const accountId = String(row.account_id || "");
    const accountName = cleanAccountName(row.account_nm || "");
    if (aliases.accountIds.has(accountId)) {
      candidates.push({ rank: 0, row });
    } else if (exactNames.has(accountName)) {
      candidates.push({ rank: 1, row });
    }
  }
  if (!candidates.length) {
    for (const row of rows) {
      const accountName = cleanAccountName(row.account_nm || "");
      if (metricName === "operating_revenue" && !isTotalOperatingRevenueName(accountName)) continue;
      if (aliases.names.some((name) => accountName.includes(cleanAccountName(name)))) {
        candidates.push({ rank: 2, row });
      }
    }
  }
  if (!candidates.length) return { value: null, basis: "", account: "" };
  candidates.sort((a, b) => {
    return (
      statementPriority(metricName, a.row) - statementPriority(metricName, b.row) ||
      a.rank - b.rank ||
      zeroAmountScore(a.row, metricName, reportCode) - zeroAmountScore(b.row, metricName, reportCode) ||
      ord(a.row) - ord(b.row)
    );
  });
  const row = candidates[0].row;
  const amountKey = amountKeyForMetric(metricName, reportCode, row);
  return { value: parseAmount(row[amountKey]), basis: amountKey, account: String(row.account_nm || "") };
}

function deriveOperatingRevenue(rows, reportCode) {
  const values = [];
  const labels = [];
  for (const spec of REVENUE_COMPONENTS) {
    const matches = rows.filter((row) => {
      if (statementPriority("operating_revenue", row) > 0) return false;
      const accountId = String(row.account_id || "");
      const accountName = cleanAccountName(row.account_nm || "");
      return spec.ids.includes(accountId) || spec.names.some((name) => cleanAccountName(name) === accountName);
    });
    if (!matches.length) continue;
    matches.sort((a, b) => zeroAmountScore(a, "operating_revenue", reportCode) - zeroAmountScore(b, "operating_revenue", reportCode) || ord(a) - ord(b));
    const value = parseAmount(matches[0][amountKeyForMetric("operating_revenue", reportCode, matches[0])]);
    if (value != null) {
      values.push(value);
      labels.push(spec.label);
    }
  }
  if (!values.length) return { value: null, basis: "", account: "" };
  return { value: values.reduce((sum, value) => sum + value, 0), basis: "구성항목 합산", account: labels.join(" + ") };
}

function filterPeriodicFilings(filings) {
  return filings.filter((filing) => PERIODIC_REPORT_WORDS.some((word) => filing.report_nm.includes(word)));
}

function inferReportFromName(reportName) {
  if (reportName.includes("사업보고서")) return "annual";
  if (reportName.includes("반기보고서")) return "half";
  if (reportName.includes("분기보고서")) {
    const month = /\((\d{4})\.(\d{2})\)/.exec(reportName);
    return month?.[2] === "09" ? "q3" : "q1";
  }
  return "";
}

function inferYearFromReport(reportName, receiptDate) {
  const match = /\((\d{4})\.\d{2}\)/.exec(reportName);
  if (match) return Number(match[1]);
  if (reportName.includes("사업보고서") && /^\d{8}$/.test(receiptDate)) return Number(receiptDate.slice(0, 4)) - 1;
  if (/^\d{8}$/.test(receiptDate)) return Number(receiptDate.slice(0, 4));
  return new Date().getFullYear();
}

function missingReason(companyName, year, reportLabel, warnings) {
  const text = warnings.filter((warning) => warning.startsWith(`${companyName} ${year}/`)).join("; ");
  if (!text) return "재무 데이터 없음";
  if (text.includes("XBRL fallback용 접수번호 없음")) return `${reportLabel} 접수번호 없음`;
  if (text.includes("XBRL에서 핵심 계정 추출 실패")) return "XBRL 핵심 계정 추출 실패";
  if (text.includes("XBRL fallback 실패")) return "XBRL 원문 다운로드/파싱 실패";
  if (text.includes("데이터 없음")) return "재무제표 API 데이터 없음";
  return text.slice(0, 180);
}

function normalizeYears(years) {
  const source = Array.isArray(years) ? years : [new Date().getFullYear()];
  const parsed = source.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year >= 1900);
  if (!parsed.length) throw new Error("사업연도를 하나 이상 입력하세요.");
  return [...new Set(parsed)];
}

function normalizeReports(reports) {
  const source = Array.isArray(reports) && reports.length ? reports : ["annual"];
  const parsed = source.filter((key) => REPORT_KINDS[key]);
  if (!parsed.length) throw new Error("보고서 종류를 하나 이상 선택하세요.");
  return [...new Set(parsed)];
}

function latestFiling(filings) {
  return filings.slice().sort((a, b) => `${b.rcept_dt}${b.rcept_no}`.localeCompare(`${a.rcept_dt}${a.rcept_no}`))[0];
}

function compactDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function amountKeyForMetric(metricName, reportCode, row) {
  if (["assets", "liabilities", "equity"].includes(metricName)) return "thstrm_amount";
  if (reportCode !== REPORT_KINDS.annual.code && row.thstrm_add_amount) return "thstrm_add_amount";
  return "thstrm_amount";
}

function statementPriority(metricName, row) {
  const statement = String(row.sj_div || "");
  if (["assets", "liabilities", "equity"].includes(metricName)) return statement === "BS" ? 0 : 1;
  return ["IS", "CIS"].includes(statement) ? 0 : 1;
}

function zeroAmountScore(row, metricName, reportCode) {
  return parseAmount(row[amountKeyForMetric(metricName, reportCode, row)]) === 0 ? 1 : 0;
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === "-" || text === "N/A") return null;
  const negative = text.startsWith("(") && text.endsWith(")");
  const cleaned = text.replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(Math.trunc(parsed)) : Math.trunc(parsed);
}

function safeRatio(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

function attachYoy(rows, metric) {
  const index = new Map(rows.map((row) => [`${row.corp_code}|${row.reprt_code}|${row.bsns_year}`, row]));
  for (const row of rows) {
    const prev = index.get(`${row.corp_code}|${row.reprt_code}|${Number(row.bsns_year) - 1}`);
    const previous = prev?.[metric];
    row[`${metric}_yoy`] = row[metric] != null && previous != null ? safeRatio(row[metric] - previous, Math.abs(previous)) : null;
  }
}

function attachRank(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.bsns_year}|${row.reprt_code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (b.operating_income ?? -1e30) - (a.operating_income ?? -1e30));
    group.forEach((row, index) => {
      row.rank_operating_income = index + 1;
    });
  }
}

function cleanAccountName(name) {
  return String(name || "").replace(/[\s()]/g, "");
}

function isTotalOperatingRevenueName(cleanedName) {
  const blocked = ["기타영업수익", "수수료수익", "이자수익", "배당수익", "금융상품", "외환"];
  return cleanedName.includes("영업수익") && !blocked.some((term) => cleanedName.includes(term));
}

function ord(row) {
  const parsed = Number(String(row.ord || "999999").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 999999;
}

function filingKey(corpCode, year, reportKey) {
  return `${corpCode}|${year}|${reportKey}`;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  async function next() {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}
