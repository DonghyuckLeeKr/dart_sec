from __future__ import annotations

import csv
import datetime as dt
import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from .labels import label_column, localize_account_row
from .models import Company, Filing, ReportKind
from .opendart import OpenDartClient, OpenDartError
from .xbrl import parse_xbrl_financial_statement


REPORT_KINDS: dict[str, ReportKind] = {
    "q1": ReportKind("q1", "11013", "1분기보고서"),
    "half": ReportKind("half", "11012", "반기보고서"),
    "q3": ReportKind("q3", "11014", "3분기보고서"),
    "annual": ReportKind("annual", "11011", "사업보고서"),
}

REPORT_CODE_TO_KEY = {kind.code: key for key, kind in REPORT_KINDS.items()}
REPORT_PERIOD_MONTH = {
    "q1": "03",
    "half": "06",
    "q3": "09",
    "annual": "12",
}
PERIODIC_REPORT_WORDS = ("사업보고서", "분기보고서", "반기보고서")

METRIC_ALIASES = {
    "operating_revenue": {
        "account_ids": {"ifrs-full_Revenue", "dart_OperatingRevenue"},
        "names": ("영업수익", "매출액", "수익(매출액)", "영업수익(매출액)"),
    },
    "operating_income": {
        "account_ids": {"dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"},
        "names": ("영업이익", "영업이익(손실)", "영업손익", "영업활동손익"),
    },
    "pretax_income": {
        "account_ids": {"ifrs-full_ProfitLossBeforeTax", "ifrs-full_ProfitLossFromContinuingOperationsBeforeTax"},
        "names": (
            "세전이익",
            "법인세비용차감전순이익",
            "법인세비용차감전순이익(손실)",
            "법인세비용차감전계속영업이익",
            "법인세비용차감전계속영업이익(손실)",
            "법인세차감전순이익",
            "법인세차감전순이익(손실)",
            "분기법인세비용차감전순이익",
            "반기법인세비용차감전순이익",
        ),
    },
    "net_income": {
        "account_ids": {"ifrs-full_ProfitLoss"},
        "names": ("당기순이익", "당기순이익(손실)", "분기순이익", "반기순이익", "연결당기순이익"),
    },
    "assets": {
        "account_ids": {"ifrs-full_Assets"},
        "names": ("자산총계", "총자산"),
    },
    "liabilities": {
        "account_ids": {"ifrs-full_Liabilities"},
        "names": ("부채총계", "총부채"),
    },
    "equity": {
        "account_ids": {"ifrs-full_Equity"},
        "names": ("자본총계", "총자본", "자기자본", "자본총계(자기자본)"),
    },
}

OPERATING_REVENUE_DERIVATION = {
    "fee_income": {
        "label": "수수료수익",
        "primary": {"ifrs-full_FeeAndCommissionIncome"},
        "names": {"수수료수익", "FeeAndCommissionIncome"},
    },
    "interest_revenue": {
        "label": "이자수익",
        "primary": {"ifrs-full_RevenueFromInterest"},
        "names": {"이자수익", "RevenueFromInterest"},
    },
    "dividend_revenue": {
        "label": "배당수익",
        "primary": {"ifrs-full_RevenueFromDividends"},
        "names": {"배당수익", "RevenueFromDividends"},
    },
    "financial_instruments": {
        "label": "금융상품관련이익/순손익",
        "primary": {"ifrs-full_GainFromFinancialInstruments"},
        "names": {"금융상품관련이익", "GainFromFinancialInstruments"},
        "fallback": {
            "ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
            "ifrs-full_GainFromFinancialInstrumentsAtAmortisedCost",
            "ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome",
            "ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
            "ifrs-full_GainLossFromFinancialInstrumentsAtAmortisedCost",
            "ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome",
            "dart_GainLossFromFinancialInstrumentsAtAmortisedCost",
            "dart_GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome",
            "dart_GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
        },
        "fallback_names": {
            "금융상품관련순손익",
            "당기손익-공정가치측정금융상품관련순손익",
            "상각후원가측정금융상품관련순손익",
            "기타포괄손익-공정가치측정금융자산관련순손익",
            "GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
            "GainLossFromFinancialInstrumentsAtAmortisedCost",
            "GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome",
        },
    },
    "foreign_exchange": {
        "label": "외환거래이익/손익",
        "primary": {"ifrs-full_ForeignExchangeGain", "ifrs-full_GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss"},
        "names": {"외환거래이익", "외환거래손익", "ForeignExchangeGain", "GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss"},
    },
    "other_operating": {
        "label": "기타영업수익/손익",
        "primary": {"ifrs-full_OtherOperatingIncome", "dart_OtherOperatingIncome"},
        "names": {"기타영업수익", "OtherOperatingIncome"},
        "fallback": {"ifrs-full_OtherOperatingIncomeExpense", "ifrs-full_MiscellaneousOtherOperatingIncome", "dart_OtherOperatingIncomeExpense"},
        "fallback_names": {"기타의영업손익", "MiscellaneousOtherOperatingIncome", "OtherOperatingIncomeExpense"},
    },
}


def collect_financials(
    client: OpenDartClient,
    companies: list[Company],
    years: list[int],
    report_keys: list[str],
    fs_div: str,
    fallback_ofs: bool,
    xbrl_fallback: bool = True,
) -> tuple[list[dict[str, Any]], list[str]]:
    raw_rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    for company in companies:
        for year in years:
            for report_key in report_keys:
                kind = REPORT_KINDS[report_key]
                rows, used_div, message = _fetch_statement_with_fallback(
                    client,
                    company=company,
                    year=year,
                    report_code=kind.code,
                    fs_div=fs_div,
                    fallback_ofs=fallback_ofs,
                )
                data_source = "OpenDART 재무제표 API"
                if not rows and xbrl_fallback:
                    xbrl_rows, xbrl_used_div, xbrl_message = _fetch_statement_from_xbrl(
                        client,
                        company=company,
                        year=year,
                        report_key=report_key,
                        fs_div=fs_div,
                        fallback_ofs=fallback_ofs,
                    )
                    if xbrl_rows:
                        rows = xbrl_rows
                        used_div = xbrl_used_div
                        data_source = "XBRL 원문"
                        message = xbrl_message
                    elif xbrl_message:
                        message = f"{message}; {xbrl_message}" if message else xbrl_message
                if message:
                    warnings.append(message)
                for row in rows:
                    enriched = localize_account_row(dict(row))
                    enriched.update(
                        {
                            "sector_corp_name": company.corp_name,
                            "sector_stock_code": company.stock_code,
                            "requested_fs_div": fs_div,
                            "used_fs_div": used_div,
                            "data_source": row.get("data_source") or data_source,
                            "report_key": report_key,
                            "report_label": kind.label,
                        }
                    )
                    raw_rows.append(enriched)
    return raw_rows, warnings


def build_metrics(raw_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in raw_rows:
        grouped[
            (
                str(row.get("corp_code", "")),
                str(row.get("bsns_year", "")),
                str(row.get("reprt_code", "")),
                str(row.get("used_fs_div", "")),
            )
        ].append(row)

    metrics_rows: list[dict[str, Any]] = []
    for (_corp_code, year, report_code, used_fs_div), rows in grouped.items():
        if not rows:
            continue
        first = rows[0]
        values: dict[str, int | None] = {}
        basis: dict[str, str] = {}
        source_accounts: dict[str, str] = {}
        for metric_name in METRIC_ALIASES:
            value, value_basis, source = _find_metric(rows, metric_name, report_code)
            values[metric_name] = value
            basis[f"{metric_name}_basis"] = value_basis
            source_accounts[f"{metric_name}_account"] = source

        revenue = values["operating_revenue"]
        op_income = values["operating_income"]
        net_income = values["net_income"]
        liabilities = values["liabilities"]
        equity = values["equity"]
        revenue_estimate, revenue_estimate_basis, revenue_estimate_source = _derive_operating_revenue(rows, report_code) if revenue is None else (None, "", "")

        metrics_rows.append(
            {
                "corp_code": first.get("corp_code", ""),
                "corp_name": first.get("sector_corp_name") or first.get("corp_name", ""),
                "stock_code": first.get("stock_code") or first.get("sector_stock_code", ""),
                "bsns_year": year,
                "reprt_code": report_code,
                "report_key": REPORT_CODE_TO_KEY.get(report_code, ""),
                "report_label": first.get("report_label", ""),
                "fs_div": used_fs_div,
                **values,
                "operating_revenue_estimate": revenue_estimate,
                "operating_margin": _safe_ratio(op_income, revenue),
                "operating_margin_estimate": _safe_ratio(op_income, revenue_estimate),
                "net_margin": _safe_ratio(net_income, revenue),
                "roe": _safe_ratio(net_income, equity),
                "debt_ratio": _safe_ratio(liabilities, equity),
                **basis,
                "operating_revenue_estimate_basis": revenue_estimate_basis,
                **source_accounts,
                "operating_revenue_estimate_account": revenue_estimate_source,
                "rcept_no": first.get("rcept_no", ""),
                "currency": first.get("currency", ""),
                "data_source": first.get("data_source", ""),
                "collection_status": "수집 완료",
                "failure_reason": "",
            }
        )

    _attach_yoy(metrics_rows, "operating_income")
    _attach_yoy(metrics_rows, "pretax_income")
    _attach_yoy(metrics_rows, "net_income")
    _attach_rank(metrics_rows)
    return sorted(metrics_rows, key=lambda row: (row["bsns_year"], row["reprt_code"], row.get("rank_operating_income") or 9999))


def build_coverage_rows(
    companies: list[Company],
    metrics_rows: list[dict[str, Any]],
    years: list[int],
    report_keys: list[str],
    warnings: list[str],
) -> list[dict[str, Any]]:
    indexed: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in metrics_rows:
        indexed[(str(row.get("corp_code", "")), str(row.get("bsns_year", "")), str(row.get("report_key", "")))].append(row)

    coverage_rows: list[dict[str, Any]] = []
    for year in years:
        for report_key in report_keys:
            kind = REPORT_KINDS[report_key]
            for company in companies:
                rows = indexed.get((company.corp_code, str(year), report_key), [])
                if rows:
                    coverage_rows.extend(rows)
                    continue
                reason = _missing_reason(company.corp_name, year, kind.label, warnings)
                coverage_rows.append(
                    {
                        "corp_code": company.corp_code,
                        "corp_name": company.corp_name,
                        "stock_code": company.stock_code,
                        "bsns_year": str(year),
                        "reprt_code": kind.code,
                        "report_key": report_key,
                        "report_label": kind.label,
                        "fs_div": "",
                        "data_source": "",
                        "collection_status": "미확보",
                        "failure_reason": reason,
                    }
                )
    return coverage_rows


def filter_periodic_filings(filings: list[Filing]) -> list[Filing]:
    return [filing for filing in filings if any(word in filing.report_nm for word in PERIODIC_REPORT_WORDS)]


def infer_report_from_name(report_name: str) -> str | None:
    if "사업보고서" in report_name:
        return "annual"
    if "반기보고서" in report_name:
        return "half"
    if "분기보고서" in report_name:
        month = re.search(r"\((\d{4})\.(\d{2})\)", report_name)
        if month and month.group(2) == "03":
            return "q1"
        if month and month.group(2) == "09":
            return "q3"
        return "q1"
    return None


def infer_year_from_report(report_name: str, receipt_date: str) -> int:
    match = re.search(r"\((\d{4})\.\d{2}\)", report_name)
    if match:
        return int(match.group(1))
    if "사업보고서" in report_name and re.fullmatch(r"\d{8}", receipt_date):
        return int(receipt_date[:4]) - 1
    if re.fullmatch(r"\d{8}", receipt_date):
        return int(receipt_date[:4])
    return dt.date.today().year


def find_periodic_filing(
    client: OpenDartClient,
    *,
    corp_code: str,
    bsns_year: int,
    report_key: str,
    final: bool = True,
) -> Filing | None:
    today = dt.date.today()
    search_start = f"{bsns_year}0101"
    search_end_date = min(today, dt.date(bsns_year + 1, 12, 31))
    if report_key == "annual":
        search_end_date = min(today, dt.date(bsns_year + 1, 6, 30))
    target_month = REPORT_PERIOD_MONTH[report_key]
    filings = client.search_disclosures(
        corp_code=corp_code,
        bgn_de=search_start,
        end_de=compact_date(search_end_date),
        final=final,
        pblntf_ty="A",
    )
    periodic = filter_periodic_filings(filings)
    exact = [
        filing
        for filing in periodic
        if infer_report_from_name(filing.report_nm) == report_key and f"({bsns_year}.{target_month})" in filing.report_nm
    ]
    if exact:
        return sorted(exact, key=lambda filing: (filing.rcept_dt, filing.rcept_no), reverse=True)[0]
    fallback = [
        filing
        for filing in periodic
        if infer_report_from_name(filing.report_nm) == report_key and infer_year_from_report(filing.report_nm, filing.rcept_dt) == bsns_year
    ]
    if fallback:
        return sorted(fallback, key=lambda filing: (filing.rcept_dt, filing.rcept_no), reverse=True)[0]
    return None


def write_csv(path: str | Path, rows: list[dict[str, Any]]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = _fieldnames(rows)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writerow({key: label_column(key) for key in fieldnames})
        writer.writerows(rows)


def write_json(path: str | Path, payload: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_markdown_report(path: str | Path, sector: str, metrics_rows: list[dict[str, Any]], warnings: list[str]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"# {sector} DART 재무실적 분석",
        "",
        f"- 생성시각: {dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 분석대상 행: {len(metrics_rows)}",
        "",
    ]

    latest = latest_rows(metrics_rows)
    if latest:
        lines.extend(
            [
                "## 최신 보고서 기준 순위",
                "",
                _markdown_table(
                    latest,
                    [
                        "rank_operating_income",
                        "corp_name",
                        "stock_code",
                        "bsns_year",
                        "report_label",
                        "data_source",
                        "operating_revenue",
                        "operating_revenue_estimate",
                        "operating_income",
                        "pretax_income",
                        "net_income",
                        "equity",
                        "operating_margin",
                        "operating_margin_estimate",
                        "roe",
                        "debt_ratio",
                    ],
                ),
                "",
            ]
        )

    report_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in metrics_rows:
        report_groups[(str(row.get("bsns_year", "")), str(row.get("report_label", "")))].append(row)
    for (year, label), rows in sorted(report_groups.items(), reverse=True):
        rows = sorted(rows, key=lambda row: row.get("rank_operating_income") or 9999)
        lines.extend(
            [
                f"## {year} {label}",
                "",
                _markdown_table(
                    rows,
                    [
                        "rank_operating_income",
                        "corp_name",
                        "data_source",
                        "operating_revenue",
                        "operating_revenue_estimate",
                        "operating_income",
                        "operating_income_yoy",
                        "pretax_income",
                        "pretax_income_yoy",
                        "net_income",
                        "net_income_yoy",
                        "operating_margin",
                        "operating_margin_estimate",
                        "roe",
                    ],
                ),
                "",
            ]
        )

    if warnings:
        lines.extend(["## 수집 경고", ""])
        for warning in warnings[:80]:
            lines.append(f"- {warning}")
        if len(warnings) > 80:
            lines.append(f"- ... {len(warnings) - 80}개 추가 경고 생략")
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def latest_rows(metrics_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_company: dict[str, dict[str, Any]] = {}
    report_order = {"annual": 4, "q3": 3, "half": 2, "q1": 1}
    for row in metrics_rows:
        corp_code = str(row.get("corp_code", ""))
        current_key = (
            int(row.get("bsns_year") or 0),
            report_order.get(str(row.get("report_key", "")), 0),
        )
        existing = by_company.get(corp_code)
        if not existing:
            by_company[corp_code] = row
            continue
        existing_key = (
            int(existing.get("bsns_year") or 0),
            report_order.get(str(existing.get("report_key", "")), 0),
        )
        if current_key > existing_key:
            by_company[corp_code] = row
    rows = list(by_company.values())
    return sorted(rows, key=lambda row: (row.get("rank_operating_income") or 9999, row.get("corp_name", "")))


def compact_date(value: dt.date) -> str:
    return value.strftime("%Y%m%d")


def _missing_reason(company_name: str, year: int, report_label: str, warnings: list[str]) -> str:
    company_warnings = [warning for warning in warnings if warning.startswith(f"{company_name} {year}/")]
    if not company_warnings:
        return "재무 데이터 없음"
    text = "; ".join(company_warnings)
    if "XBRL fallback용 접수번호 없음" in text:
        return f"{report_label} 접수번호 없음"
    if "XBRL에서 핵심 계정 추출 실패" in text:
        return "XBRL 핵심 계정 추출 실패"
    if "XBRL fallback 실패" in text:
        return "XBRL 원문 다운로드/파싱 실패"
    if "데이터 없음" in text:
        return "재무제표 API 데이터 없음"
    return company_warnings[0]


def _fetch_statement_with_fallback(
    client: OpenDartClient,
    *,
    company: Company,
    year: int,
    report_code: str,
    fs_div: str,
    fallback_ofs: bool,
) -> tuple[list[dict[str, Any]], str, str | None]:
    try:
        rows = client.financial_statement(corp_code=company.corp_code, bsns_year=year, reprt_code=report_code, fs_div=fs_div)
        if rows:
            return rows, fs_div, None
    except OpenDartError as exc:
        if not fallback_ofs or fs_div == "OFS":
            return [], fs_div, f"{company.corp_name} {year}/{report_code}/{fs_div}: {exc}"

    if fallback_ofs and fs_div != "OFS":
        try:
            rows = client.financial_statement(corp_code=company.corp_code, bsns_year=year, reprt_code=report_code, fs_div="OFS")
            if rows:
                return rows, "OFS", f"{company.corp_name} {year}/{report_code}: CFS 없음, OFS 사용"
        except OpenDartError as exc:
            return [], "OFS", f"{company.corp_name} {year}/{report_code}/OFS: {exc}"
    return [], fs_div, f"{company.corp_name} {year}/{report_code}/{fs_div}: 데이터 없음"


def _fetch_statement_from_xbrl(
    client: OpenDartClient,
    *,
    company: Company,
    year: int,
    report_key: str,
    fs_div: str,
    fallback_ofs: bool,
) -> tuple[list[dict[str, Any]], str, str | None]:
    kind = REPORT_KINDS[report_key]
    filing = find_periodic_filing(client, corp_code=company.corp_code, bsns_year=year, report_key=report_key)
    if not filing:
        return [], fs_div, f"{company.corp_name} {year}/{kind.label}: XBRL fallback용 접수번호 없음"
    try:
        raw_zip = client.xbrl_document(rcept_no=filing.rcept_no, reprt_code=kind.code)
        rows, used_div = parse_xbrl_financial_statement(
            raw_zip,
            corp_code=company.corp_code,
            corp_name=company.corp_name,
            stock_code=company.stock_code,
            bsns_year=year,
            reprt_code=kind.code,
            fs_div=fs_div,
            fallback_ofs=fallback_ofs,
            rcept_no=filing.rcept_no,
        )
    except Exception as exc:
        return [], fs_div, f"{company.corp_name} {year}/{kind.label}: XBRL fallback 실패({exc})"
    if rows:
        return rows, used_div, f"{company.corp_name} {year}/{kind.label}: API 재무제표 없음, XBRL 원문 사용({filing.rcept_no})"
    return [], fs_div, f"{company.corp_name} {year}/{kind.label}: XBRL에서 핵심 계정 추출 실패({filing.rcept_no})"


def _find_metric(rows: list[dict[str, Any]], metric_name: str, report_code: str) -> tuple[int | None, str, str]:
    aliases = METRIC_ALIASES[metric_name]
    exact_names = {_clean_account_name(name) for name in aliases["names"]}
    candidates: list[tuple[int, dict[str, Any]]] = []
    for row in rows:
        account_id = str(row.get("account_id", ""))
        account_nm = _clean_account_name(str(row.get("account_nm", "")))
        if account_id in aliases["account_ids"]:
            candidates.append((0, row))
        elif account_nm in exact_names:
            candidates.append((1, row))
    if not candidates:
        for row in rows:
            account_nm = _clean_account_name(str(row.get("account_nm", "")))
            if metric_name == "operating_revenue" and not _is_total_operating_revenue_name(account_nm):
                continue
            if any(_clean_account_name(name) in account_nm for name in aliases["names"]):
                candidates.append((2, row))
    if not candidates:
        return None, "", ""

    candidates = sorted(candidates, key=lambda pair: (_statement_priority(metric_name, pair[1]), pair[0], _is_zero_amount(pair[1], metric_name, report_code), _ord(pair[1])))
    row = candidates[0][1]
    amount_key = _amount_key_for_metric(metric_name, report_code, row)
    return _parse_amount(row.get(amount_key)), amount_key, str(row.get("account_nm", ""))


def _derive_operating_revenue(rows: list[dict[str, Any]], report_code: str) -> tuple[int | None, str, str]:
    component_values: list[int] = []
    component_labels: list[str] = []

    other_parent_exists = _component_amount(rows, report_code, OPERATING_REVENUE_DERIVATION["other_operating"], use_fallback=False)[0] is not None
    for key, spec in OPERATING_REVENUE_DERIVATION.items():
        if key == "foreign_exchange" and other_parent_exists:
            continue
        value, label = _component_amount(rows, report_code, spec, use_fallback=True)
        if value is None:
            continue
        component_values.append(value)
        component_labels.append(label)

    if not component_values:
        return None, "", ""
    return sum(component_values), "구성항목 합산", " + ".join(component_labels)


def _component_amount(rows: list[dict[str, Any]], report_code: str, spec: dict[str, Any], use_fallback: bool) -> tuple[int | None, str]:
    primary_rows = _component_rows(rows, spec.get("primary", set()), spec.get("names", set()))
    if primary_rows:
        row = sorted(primary_rows, key=lambda candidate: (_statement_priority("operating_revenue", candidate), _is_zero_amount(candidate, "operating_revenue", report_code), _ord(candidate)))[0]
        return _parse_amount(row.get(_amount_key_for_metric("operating_revenue", report_code, row))), str(spec["label"])

    if not use_fallback:
        return None, str(spec["label"])

    fallback_rows = _component_rows(rows, spec.get("fallback", set()), spec.get("fallback_names", set()))
    if not fallback_rows:
        return None, str(spec["label"])
    amounts = [_parse_amount(row.get(_amount_key_for_metric("operating_revenue", report_code, row))) for row in fallback_rows]
    values = [amount for amount in amounts if amount is not None]
    if not values:
        return None, str(spec["label"])
    return sum(values), str(spec["label"])


def _component_rows(rows: list[dict[str, Any]], account_ids: set[str], names: set[str]) -> list[dict[str, Any]]:
    normalized_names = {_clean_account_name(name) for name in names}
    matched: list[dict[str, Any]] = []
    for row in rows:
        if _statement_priority("operating_revenue", row) > 0:
            continue
        account_id = str(row.get("account_id", ""))
        account_nm = _clean_account_name(str(row.get("account_nm", "")))
        if account_id in account_ids or account_id.rsplit("_", 1)[-1] in names or account_nm in normalized_names:
            matched.append(row)
    return matched


def _is_total_operating_revenue_name(cleaned_name: str) -> bool:
    blocked_terms = ("기타영업수익", "수수료수익", "이자수익", "배당수익", "금융상품", "외환")
    return "영업수익" in cleaned_name and not any(term in cleaned_name for term in blocked_terms)


def _amount_key_for_metric(metric_name: str, report_code: str, row: dict[str, Any]) -> str:
    if metric_name in {"assets", "liabilities", "equity"}:
        return "thstrm_amount"
    if report_code != REPORT_KINDS["annual"].code and row.get("thstrm_add_amount"):
        return "thstrm_add_amount"
    return "thstrm_amount"


def _statement_priority(metric_name: str, row: dict[str, Any]) -> int:
    statement = str(row.get("sj_div", ""))
    if metric_name in {"assets", "liabilities", "equity"}:
        return 0 if statement == "BS" else 1
    return 0 if statement in {"IS", "CIS"} else 1


def _is_zero_amount(row: dict[str, Any], metric_name: str, report_code: str) -> int:
    amount = _parse_amount(row.get(_amount_key_for_metric(metric_name, report_code, row)))
    return 1 if amount == 0 else 0


def _ord(row: dict[str, Any]) -> int:
    try:
        return int(str(row.get("ord") or "999999").replace(",", "") or 999999)
    except ValueError:
        return 999999


def _parse_amount(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in {"-", "N/A"}:
        return None
    negative = text.startswith("(") and text.endswith(")")
    cleaned = re.sub(r"[^0-9.-]", "", text)
    if cleaned in {"", "-", "."}:
        return None
    try:
        amount = float(cleaned)
    except ValueError:
        return None
    if math.isnan(amount):
        return None
    parsed = int(amount)
    return -abs(parsed) if negative else parsed


def _safe_ratio(numerator: int | None, denominator: int | None) -> float | None:
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def _attach_yoy(rows: list[dict[str, Any]], metric: str) -> None:
    by_key = {(row.get("corp_code"), str(row.get("reprt_code")), int(row.get("bsns_year") or 0)): row for row in rows}
    for row in rows:
        year = int(row.get("bsns_year") or 0)
        prev = by_key.get((row.get("corp_code"), str(row.get("reprt_code")), year - 1))
        previous_value = prev.get(metric) if prev else None
        row[f"{metric}_yoy"] = _safe_ratio(
            (row.get(metric) - previous_value) if row.get(metric) is not None and previous_value is not None else None,
            abs(previous_value) if previous_value is not None else None,
        )


def _attach_rank(rows: list[dict[str, Any]]) -> None:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[(str(row.get("bsns_year", "")), str(row.get("reprt_code", "")))].append(row)
    for group_rows in groups.values():
        ranked = sorted(group_rows, key=lambda row: row.get("operating_income") if row.get("operating_income") is not None else -10**30, reverse=True)
        for idx, row in enumerate(ranked, start=1):
            row["rank_operating_income"] = idx


def _clean_account_name(name: str) -> str:
    return re.sub(r"[\s()]", "", name)


def _fieldnames(rows: list[dict[str, Any]]) -> list[str]:
    preferred = [
        "corp_code",
        "corp_name",
        "stock_code",
        "bsns_year",
        "reprt_code",
        "report_key",
        "report_label",
        "fs_div",
        "collection_status",
        "failure_reason",
        "data_source",
        "rank_operating_income",
        "operating_revenue",
        "operating_revenue_estimate",
        "operating_income",
        "operating_income_yoy",
        "pretax_income",
        "pretax_income_yoy",
        "net_income",
        "net_income_yoy",
        "assets",
        "liabilities",
        "equity",
        "operating_margin",
        "operating_margin_estimate",
        "net_margin",
        "roe",
        "debt_ratio",
        "rcept_no",
        "currency",
        "pretax_income_basis",
        "pretax_income_account",
        "operating_revenue_estimate_basis",
        "operating_revenue_estimate_account",
    ]
    seen = set(preferred)
    rest: list[str] = []
    for row in rows:
        for key in row:
            if key not in seen:
                rest.append(key)
                seen.add(key)
    return [key for key in preferred if any(key in row for row in rows)] + rest


def _markdown_table(rows: list[dict[str, Any]], columns: list[str]) -> str:
    visible_columns = [column for column in columns if any(column in row for row in rows)]
    if not rows or not visible_columns:
        return "_데이터 없음_"
    header = "| " + " | ".join(label_column(column) for column in visible_columns) + " |"
    separator = "| " + " | ".join(["---"] * len(visible_columns)) + " |"
    body = ["| " + " | ".join(_format_value(row.get(column)) for column in visible_columns) + " |" for row in rows]
    return "\n".join([header, separator, *body])


def _format_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        if value == 0:
            return "0.0%"
        return f"{value * 100:.1f}%"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value).replace("|", "/")
