CREATE TABLE IF NOT EXISTS dart_companies (
  corp_code TEXT PRIMARY KEY,
  corp_name TEXT NOT NULL,
  stock_code TEXT,
  sector TEXT NOT NULL,
  listed_type TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dart_filings (
  rcept_no TEXT PRIMARY KEY,
  corp_code TEXT NOT NULL,
  corp_name TEXT NOT NULL,
  stock_code TEXT,
  report_nm TEXT,
  report_key TEXT,
  report_label TEXT,
  bsns_year TEXT,
  rcept_dt TEXT,
  fs_div TEXT,
  data_source TEXT,
  pdf_key TEXT,
  xbrl_key TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dart_financial_metrics (
  sector TEXT NOT NULL,
  corp_code TEXT NOT NULL,
  corp_name TEXT NOT NULL,
  stock_code TEXT,
  bsns_year TEXT NOT NULL,
  report_key TEXT NOT NULL,
  report_label TEXT,
  reprt_code TEXT,
  fs_div TEXT,
  requested_fs_div TEXT NOT NULL DEFAULT '',
  collection_status TEXT,
  failure_reason TEXT,
  data_source TEXT,
  rcept_no TEXT,
  rcept_dt TEXT,
  operating_revenue INTEGER,
  operating_revenue_estimate INTEGER,
  operating_income INTEGER,
  pretax_income INTEGER,
  net_income INTEGER,
  equity INTEGER,
  assets INTEGER,
  liabilities INTEGER,
  operating_margin REAL,
  operating_margin_estimate REAL,
  roe REAL,
  debt_ratio REAL,
  row_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (corp_code, bsns_year, report_key, requested_fs_div)
);

CREATE INDEX IF NOT EXISTS idx_dart_metrics_sector_period
  ON dart_financial_metrics (sector, bsns_year, report_key);

CREATE INDEX IF NOT EXISTS idx_dart_metrics_company
  ON dart_financial_metrics (corp_code, bsns_year, report_key);

CREATE INDEX IF NOT EXISTS idx_dart_filings_company_period
  ON dart_filings (corp_code, bsns_year, report_key);
