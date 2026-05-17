export const REPORT_KINDS = {
  q1: { key: "q1", code: "11013", label: "1분기보고서", periodMonth: "03" },
  half: { key: "half", code: "11012", label: "반기보고서", periodMonth: "06" },
  q3: { key: "q3", code: "11014", label: "3분기보고서", periodMonth: "09" },
  annual: { key: "annual", code: "11011", label: "사업보고서", periodMonth: "12" }
};

export const REPORT_CODE_TO_KEY = Object.fromEntries(Object.values(REPORT_KINDS).map((kind) => [kind.code, kind.key]));

export const COLUMN_LABELS = {
  rank_operating_income: "영업이익순위",
  corp_name: "회사명",
  stock_code: "종목코드",
  bsns_year: "사업연도",
  report_label: "보고서명",
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
  rcept_no: "접수번호",
  pdf: "원문"
};

export const METRIC_COLUMNS = [
  "rank_operating_income",
  "corp_name",
  "stock_code",
  "bsns_year",
  "report_label",
  "pdf",
  "fs_div",
  "collection_status",
  "failure_reason",
  "data_source",
  "operating_revenue",
  "operating_revenue_estimate",
  "operating_revenue_estimate_basis",
  "operating_income",
  "operating_income_yoy",
  "pretax_income",
  "pretax_income_yoy",
  "net_income",
  "net_income_yoy",
  "equity",
  "operating_margin",
  "operating_margin_estimate",
  "roe",
  "debt_ratio",
  "rcept_dt",
  "rcept_no"
];

export const FILING_COLUMNS = ["rcept_dt", "corp_name", "stock_code", "report_nm", "pdf", "rcept_no"];
