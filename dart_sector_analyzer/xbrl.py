from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from typing import Any
from xml.etree import ElementTree as ET

from .labels import ACCOUNT_ID_LABELS, korean_account_name


XBRLI = "http://www.xbrl.org/2003/instance"
XBRLDI = "http://xbrl.org/2006/xbrldi"

REPORT_PERIOD_END = {
    "11013": "03-31",
    "11012": "06-30",
    "11014": "09-30",
    "11011": "12-31",
}

FACTS = {
    "operating_revenue": {
        "local_names": ("Revenue", "OperatingRevenue"),
        "account_id": "ifrs-full_Revenue",
        "account_nm": "영업수익",
        "period": "duration",
        "ord": "1",
    },
    "operating_income": {
        "local_names": ("ProfitLossFromOperatingActivities", "OperatingIncomeLoss"),
        "account_id": "ifrs-full_ProfitLossFromOperatingActivities",
        "account_nm": "영업이익",
        "period": "duration",
        "ord": "2",
    },
    "pretax_income": {
        "local_names": ("ProfitLossBeforeTax", "ProfitLossFromContinuingOperationsBeforeTax"),
        "account_id": "ifrs-full_ProfitLossBeforeTax",
        "account_nm": "세전이익",
        "period": "duration",
        "ord": "3",
    },
    "net_income": {
        "local_names": ("ProfitLoss",),
        "account_id": "ifrs-full_ProfitLoss",
        "account_nm": "당기순이익",
        "period": "duration",
        "ord": "4",
    },
    "assets": {
        "local_names": ("Assets",),
        "account_id": "ifrs-full_Assets",
        "account_nm": "자산총계",
        "period": "instant",
        "ord": "5",
    },
    "liabilities": {
        "local_names": ("Liabilities",),
        "account_id": "ifrs-full_Liabilities",
        "account_nm": "부채총계",
        "period": "instant",
        "ord": "6",
    },
    "equity": {
        "local_names": ("Equity",),
        "account_id": "ifrs-full_Equity",
        "account_nm": "자본총계(자기자본)",
        "period": "instant",
        "ord": "7",
    },
}

COMPONENT_FACTS = {
    "FeeAndCommissionIncome": ("ifrs-full_FeeAndCommissionIncome", "수수료수익"),
    "RevenueFromInterest": ("ifrs-full_RevenueFromInterest", "이자수익"),
    "RevenueFromDividends": ("ifrs-full_RevenueFromDividends", "배당수익"),
    "GainFromFinancialInstruments": ("ifrs-full_GainFromFinancialInstruments", "금융상품관련이익"),
    "GainFromFinancialInstrumentsAtFairValueThroughProfitOrLoss": ("ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughProfitOrLoss", "당기손익-공정가치측정금융상품관련이익"),
    "GainFromFinancialInstrumentsAtAmortisedCost": ("ifrs-full_GainFromFinancialInstrumentsAtAmortisedCost", "상각후원가측정금융상품관련이익"),
    "GainFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome": ("ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome", "기타포괄손익-공정가치측정금융자산관련이익"),
    "GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss": ("ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss", "당기손익-공정가치측정금융상품관련순손익"),
    "GainLossFromFinancialInstrumentsAtAmortisedCost": ("ifrs-full_GainLossFromFinancialInstrumentsAtAmortisedCost", "상각후원가측정금융상품관련순손익"),
    "GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome": ("ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome", "기타포괄손익-공정가치측정금융자산관련순손익"),
    "ForeignExchangeGain": ("ifrs-full_ForeignExchangeGain", "외환거래이익"),
    "GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss": ("ifrs-full_GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss", "외환거래손익"),
    "OtherOperatingIncome": ("ifrs-full_OtherOperatingIncome", "기타영업수익"),
    "OtherOperatingIncomeExpense": ("ifrs-full_OtherOperatingIncomeExpense", "기타의영업손익"),
    "MiscellaneousOtherOperatingIncome": ("ifrs-full_MiscellaneousOtherOperatingIncome", "기타영업수익"),
}


@dataclass(frozen=True)
class ContextInfo:
    context_id: str
    instant: str = ""
    start_date: str = ""
    end_date: str = ""
    members: tuple[str, ...] = ()


def parse_xbrl_financial_statement(
    raw_zip: bytes,
    *,
    corp_code: str,
    corp_name: str,
    stock_code: str,
    bsns_year: int,
    reprt_code: str,
    fs_div: str,
    fallback_ofs: bool,
    rcept_no: str,
) -> tuple[list[dict[str, Any]], str]:
    root = _xbrl_root(raw_zip)
    contexts = _contexts(root)
    period_end = f"{bsns_year}-{REPORT_PERIOD_END[reprt_code]}"

    for candidate_fs_div in _fs_div_candidates(fs_div, fallback_ofs):
        rows = _extract_for_fs_div(
            root=root,
            contexts=contexts,
            corp_code=corp_code,
            corp_name=corp_name,
            stock_code=stock_code,
            bsns_year=bsns_year,
            reprt_code=reprt_code,
            fs_div=candidate_fs_div,
            period_end=period_end,
            rcept_no=rcept_no,
        )
        if rows:
            return rows, candidate_fs_div
    return [], fs_div


def _xbrl_root(raw_zip: bytes) -> ET.Element:
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as archive:
        xbrl_name = next((name for name in archive.namelist() if name.lower().endswith((".xbrl", ".xml")) and "_lab-" not in name), None)
        if not xbrl_name:
            raise ValueError("XBRL ZIP 안에서 XBRL 파일을 찾지 못했습니다.")
        return ET.fromstring(archive.read(xbrl_name))


def _contexts(root: ET.Element) -> dict[str, ContextInfo]:
    contexts: dict[str, ContextInfo] = {}
    for item in root.findall(f"{{{XBRLI}}}context"):
        context_id = item.attrib.get("id", "")
        period = item.find(f"{{{XBRLI}}}period")
        instant = _find_text(period, "instant")
        start_date = _find_text(period, "startDate")
        end_date = _find_text(period, "endDate")
        members = tuple(member.text or "" for member in item.findall(f".//{{{XBRLDI}}}explicitMember"))
        contexts[context_id] = ContextInfo(context_id, instant, start_date, end_date, members)
    return contexts


def _extract_for_fs_div(
    *,
    root: ET.Element,
    contexts: dict[str, ContextInfo],
    corp_code: str,
    corp_name: str,
    stock_code: str,
    bsns_year: int,
    reprt_code: str,
    fs_div: str,
    period_end: str,
    rcept_no: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    member = "ConsolidatedMember" if fs_div == "CFS" else "SeparateMember"
    for metric_name, spec in FACTS.items():
        context_ids = _matching_context_ids(contexts, period_end=period_end, period_type=spec["period"], member_keyword=member)
        fact = _find_fact(root, context_ids, spec["local_names"])
        if fact is None:
            continue
        local_name = _local_name(fact.tag)
        account_id = _account_id(local_name, str(spec["account_id"]))
        amount = (fact.text or "").strip()
        row = {
            "corp_code": corp_code,
            "corp_name": corp_name,
            "stock_code": stock_code,
            "bsns_year": str(bsns_year),
            "reprt_code": reprt_code,
            "account_id": account_id,
            "account_nm": korean_account_name(account_id, str(spec["account_nm"])),
            "sj_div": "BS" if spec["period"] == "instant" else "IS",
            "sj_nm": "재무상태표" if spec["period"] == "instant" else "손익계산서",
            "thstrm_amount": amount,
            "thstrm_add_amount": amount if spec["period"] == "duration" else "",
            "ord": str(spec["ord"]),
            "currency": fact.attrib.get("unitRef", ""),
            "rcept_no": rcept_no,
            "data_source": "XBRL 원문",
            "xbrl_metric": metric_name,
        }
        rows.append(row)
    rows.extend(
        _extract_component_rows(
            root=root,
            contexts=contexts,
            corp_code=corp_code,
            corp_name=corp_name,
            stock_code=stock_code,
            bsns_year=bsns_year,
            reprt_code=reprt_code,
            period_end=period_end,
            member=member,
            rcept_no=rcept_no,
        )
    )
    return rows


def _extract_component_rows(
    *,
    root: ET.Element,
    contexts: dict[str, ContextInfo],
    corp_code: str,
    corp_name: str,
    stock_code: str,
    bsns_year: int,
    reprt_code: str,
    period_end: str,
    member: str,
    rcept_no: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    context_ids = _matching_context_ids(contexts, period_end=period_end, period_type="duration", member_keyword=member)
    for idx, (local_name, (account_id, account_nm)) in enumerate(COMPONENT_FACTS.items(), start=101):
        fact = _find_fact(root, context_ids, (local_name,))
        if fact is None:
            continue
        amount = (fact.text or "").strip()
        rows.append(
            {
                "corp_code": corp_code,
                "corp_name": corp_name,
                "stock_code": stock_code,
                "bsns_year": str(bsns_year),
                "reprt_code": reprt_code,
                "account_id": account_id,
                "account_nm": korean_account_name(account_id, account_nm),
                "sj_div": "IS",
                "sj_nm": "손익계산서",
                "thstrm_amount": amount,
                "thstrm_add_amount": amount,
                "ord": str(idx),
                "currency": fact.attrib.get("unitRef", ""),
                "rcept_no": rcept_no,
                "data_source": "XBRL 원문",
                "xbrl_component": local_name,
            }
        )
    return rows


def _matching_context_ids(
    contexts: dict[str, ContextInfo],
    *,
    period_end: str,
    period_type: str,
    member_keyword: str,
) -> list[str]:
    matches: list[ContextInfo] = []
    for context in contexts.values():
        if period_type == "instant":
            if context.instant != period_end:
                continue
        elif not (context.start_date.endswith("-01-01") and context.end_date == period_end):
            continue
        if not any(member_keyword in member for member in context.members):
            continue
        matches.append(context)

    def score(context: ContextInfo) -> tuple[int, int, int]:
        non_statement_members = [member for member in context.members if "ConsolidatedAndSeparateFinancialStatementsAxis" not in member]
        accumulated_preference = 0 if re.search(r"dF[A-Z]*A_", context.context_id) else 1
        return (len(non_statement_members), accumulated_preference, len(context.context_id))

    return [context.context_id for context in sorted(matches, key=score)]


def _find_fact(root: ET.Element, context_ids: list[str], local_names: tuple[str, ...]) -> ET.Element | None:
    context_rank = {context_id: idx for idx, context_id in enumerate(context_ids)}
    facts: list[tuple[int, ET.Element]] = []
    for item in root.iter():
        context_ref = item.attrib.get("contextRef", "")
        if context_ref not in context_rank:
            continue
        if _local_name(item.tag) not in local_names:
            continue
        text = (item.text or "").strip()
        if not re.fullmatch(r"-?\d+(\.\d+)?", text):
            continue
        facts.append((context_rank[context_ref], item))
    if not facts:
        return None
    return sorted(facts, key=lambda pair: pair[0])[0][1]


def _find_text(element: ET.Element | None, tag: str) -> str:
    if element is None:
        return ""
    node = element.find(f"{{{XBRLI}}}{tag}")
    return (node.text or "").strip() if node is not None else ""


def _fs_div_candidates(fs_div: str, fallback_ofs: bool) -> tuple[str, ...]:
    return ("CFS", "OFS") if fs_div == "CFS" and fallback_ofs else (fs_div,)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _account_id(local_name: str, fallback: str) -> str:
    for account_id in ACCOUNT_ID_LABELS:
        if account_id.endswith(f"_{local_name}"):
            return account_id
    return fallback
