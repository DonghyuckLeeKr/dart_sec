import { METRIC_COLUMNS } from "./constants.js";

const REPORT_ORDER_SQL = "CASE report_key WHEN 'q1' THEN 1 WHEN 'half' THEN 2 WHEN 'q3' THEN 3 WHEN 'annual' THEN 4 ELSE 9 END";

export function storageStatus(env) {
  return {
    d1: Boolean(env?.DART_DB),
    r2: Boolean(env?.DART_BUCKET)
  };
}

export async function persistAnalysis(env, result, payload = {}) {
  const db = env?.DART_DB;
  if (!db) return { enabled: false, rows: 0 };

  const now = new Date().toISOString();
  const sector = result.sector || payload.sector || "securities";
  const requestedFsDiv = payload.fsDiv || result.fsDiv || "";
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const statements = [];

  for (const row of rows) {
    if (row.corp_code) {
      statements.push(db.prepare(`
        INSERT INTO dart_companies (corp_code, corp_name, stock_code, sector, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(corp_code) DO UPDATE SET
          corp_name = excluded.corp_name,
          stock_code = excluded.stock_code,
          sector = excluded.sector,
          updated_at = excluded.updated_at
      `).bind(row.corp_code, row.corp_name || "", row.stock_code || "", sector, now));
    }

    if (row.rcept_no) {
      statements.push(db.prepare(`
        INSERT INTO dart_filings (
          rcept_no, corp_code, corp_name, stock_code, report_nm, report_key,
          report_label, bsns_year, rcept_dt, fs_div, data_source, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(rcept_no) DO UPDATE SET
          corp_code = excluded.corp_code,
          corp_name = excluded.corp_name,
          stock_code = excluded.stock_code,
          report_key = excluded.report_key,
          report_label = excluded.report_label,
          bsns_year = excluded.bsns_year,
          rcept_dt = excluded.rcept_dt,
          fs_div = excluded.fs_div,
          data_source = excluded.data_source,
          updated_at = excluded.updated_at
      `).bind(
        row.rcept_no,
        row.corp_code || "",
        row.corp_name || "",
        row.stock_code || "",
        row.report_nm || row.report_label || "",
        row.report_key || "",
        row.report_label || "",
        String(row.bsns_year || ""),
        row.rcept_dt || "",
        row.fs_div || requestedFsDiv,
        row.data_source || "",
        now
      ));
    }

    const storedRow = { ...row, sector, requested_fs_div: requestedFsDiv };
    statements.push(db.prepare(`
      INSERT INTO dart_financial_metrics (
        sector, corp_code, corp_name, stock_code, bsns_year, report_key,
        report_label, reprt_code, fs_div, requested_fs_div, collection_status,
        failure_reason, data_source, rcept_no, rcept_dt, operating_revenue,
        operating_revenue_estimate, operating_income, pretax_income, net_income,
        equity, assets, liabilities, operating_margin, operating_margin_estimate,
        roe, debt_ratio, row_json, updated_at
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
        ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29
      )
      ON CONFLICT(corp_code, bsns_year, report_key, requested_fs_div) DO UPDATE SET
        sector = excluded.sector,
        corp_name = excluded.corp_name,
        stock_code = excluded.stock_code,
        report_label = excluded.report_label,
        reprt_code = excluded.reprt_code,
        fs_div = excluded.fs_div,
        collection_status = excluded.collection_status,
        failure_reason = excluded.failure_reason,
        data_source = excluded.data_source,
        rcept_no = excluded.rcept_no,
        rcept_dt = excluded.rcept_dt,
        operating_revenue = excluded.operating_revenue,
        operating_revenue_estimate = excluded.operating_revenue_estimate,
        operating_income = excluded.operating_income,
        pretax_income = excluded.pretax_income,
        net_income = excluded.net_income,
        equity = excluded.equity,
        assets = excluded.assets,
        liabilities = excluded.liabilities,
        operating_margin = excluded.operating_margin,
        operating_margin_estimate = excluded.operating_margin_estimate,
        roe = excluded.roe,
        debt_ratio = excluded.debt_ratio,
        row_json = excluded.row_json,
        updated_at = excluded.updated_at
    `).bind(
      sector,
      row.corp_code || "",
      row.corp_name || "",
      row.stock_code || "",
      String(row.bsns_year || ""),
      row.report_key || "",
      row.report_label || "",
      row.reprt_code || "",
      row.fs_div || "",
      requestedFsDiv,
      row.collection_status || "",
      row.failure_reason || "",
      row.data_source || "",
      row.rcept_no || "",
      row.rcept_dt || "",
      numericOrNull(row.operating_revenue),
      numericOrNull(row.operating_revenue_estimate),
      numericOrNull(row.operating_income),
      numericOrNull(row.pretax_income),
      numericOrNull(row.net_income),
      numericOrNull(row.equity),
      numericOrNull(row.assets),
      numericOrNull(row.liabilities),
      numericOrNull(row.operating_margin),
      numericOrNull(row.operating_margin_estimate),
      numericOrNull(row.roe),
      numericOrNull(row.debt_ratio),
      JSON.stringify(storedRow),
      now
    ));
  }

  if (statements.length) {
    await db.batch(statements);
  }
  return { enabled: true, rows: rows.length };
}

export async function historyRows(env, options = {}) {
  const db = env?.DART_DB;
  if (!db) return { enabled: false, rows: [], columns: METRIC_COLUMNS };

  const sector = options.sector || "securities";
  const reports = normalizeList(options.reports);
  const fsDiv = options.fsDiv || "";
  const limit = Math.min(Math.max(Number(options.limit || 5000), 1), 10000);
  const where = ["sector = ?"];
  const binds = [sector];

  if (reports.length) {
    where.push(`report_key IN (${reports.map(() => "?").join(",")})`);
    binds.push(...reports);
  }
  if (fsDiv) {
    where.push("(requested_fs_div = ? OR fs_div = ? OR fs_div = '')");
    binds.push(fsDiv, fsDiv);
  }
  binds.push(limit);

  const sql = `
    SELECT row_json
    FROM dart_financial_metrics
    WHERE ${where.join(" AND ")}
    ORDER BY CAST(bsns_year AS INTEGER), ${REPORT_ORDER_SQL}, corp_name
    LIMIT ?
  `;
  const result = await db.prepare(sql).bind(...binds).all();
  const rows = (result.results || []).map((record) => safeJson(record.row_json)).filter(Boolean);
  return { enabled: true, rows, columns: METRIC_COLUMNS };
}

export async function cachedPdf(env, rceptNo) {
  const bucket = env?.DART_BUCKET;
  if (!bucket) return null;
  const key = pdfKey(rceptNo);
  const object = await bucket.get(key);
  return object ? { key, object } : null;
}

export async function cachePdf(env, rceptNo, bytes, fileName = "") {
  const bucket = env?.DART_BUCKET;
  if (!bucket) return { enabled: false, key: "" };
  const key = pdfKey(rceptNo);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { fileName }
  });
  await persistPdfKey(env, rceptNo, key);
  return { enabled: true, key };
}

export async function persistPdfKey(env, rceptNo, pdfKeyValue) {
  const db = env?.DART_DB;
  if (!db || !rceptNo) return;
  await db.prepare("UPDATE dart_filings SET pdf_key = ?1, updated_at = ?2 WHERE rcept_no = ?3")
    .bind(pdfKeyValue, new Date().toISOString(), rceptNo)
    .run();
}

function pdfKey(rceptNo) {
  return `pdf/${rceptNo}.pdf`;
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
