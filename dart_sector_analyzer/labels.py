from __future__ import annotations

import re


COLUMN_LABELS = {
    "corp_code": "고유번호",
    "corp_name": "회사명",
    "sector_corp_name": "섹터표시명",
    "stock_code": "종목코드",
    "sector_stock_code": "섹터종목코드",
    "corp_cls": "법인구분",
    "bsns_year": "사업연도",
    "reprt_code": "보고서코드",
    "report_key": "보고서구분",
    "report_label": "보고서명",
    "report_nm": "공시보고서명",
    "fs_div": "재무제표",
    "requested_fs_div": "요청재무제표",
    "used_fs_div": "사용재무제표",
    "data_source": "데이터출처",
    "collection_status": "수집상태",
    "failure_reason": "미확보사유",
    "rank_operating_income": "영업이익순위",
    "operating_revenue": "영업수익(공식)",
    "operating_revenue_estimate": "영업수익(추정)",
    "operating_income": "영업이익",
    "operating_income_yoy": "영업이익 YoY",
    "pretax_income": "세전이익",
    "pretax_income_yoy": "세전이익 YoY",
    "net_income": "당기순이익",
    "net_income_yoy": "당기순이익 YoY",
    "assets": "자산총계",
    "liabilities": "부채총계",
    "equity": "자본총계(자기자본)",
    "operating_margin": "영업이익률",
    "operating_margin_estimate": "영업이익률(추정)",
    "net_margin": "순이익률",
    "roe": "ROE",
    "debt_ratio": "부채비율",
    "rcept_no": "접수번호",
    "rcept_dt": "접수일",
    "currency": "통화",
    "dcm_no": "문서번호",
    "pdf_path": "PDF 경로",
    "download_status": "다운로드상태",
    "download_message": "다운로드메시지",
    "file_size": "파일크기",
    "account_id": "계정ID",
    "account_nm": "계정명",
    "account_nm_original": "원계정명",
    "account_nm_ko": "계정명(한글)",
    "sj_div": "재무제표구분",
    "sj_nm": "재무제표명",
    "thstrm_nm": "당기명",
    "thstrm_amount": "당기금액",
    "thstrm_add_amount": "당기누적금액",
    "frmtrm_nm": "전기명",
    "frmtrm_amount": "전기금액",
    "frmtrm_add_amount": "전기누적금액",
    "bfefrmtrm_nm": "전전기명",
    "bfefrmtrm_amount": "전전기금액",
    "ord": "표시순서",
    "operating_revenue_basis": "영업수익 기준",
    "operating_revenue_estimate_basis": "영업수익(추정) 기준",
    "operating_income_basis": "영업이익 기준",
    "pretax_income_basis": "세전이익 기준",
    "net_income_basis": "당기순이익 기준",
    "assets_basis": "자산총계 기준",
    "liabilities_basis": "부채총계 기준",
    "equity_basis": "자본총계 기준",
    "operating_revenue_account": "영업수익 계정",
    "operating_revenue_estimate_account": "영업수익(추정) 구성",
    "operating_income_account": "영업이익 계정",
    "pretax_income_account": "세전이익 계정",
    "net_income_account": "당기순이익 계정",
    "assets_account": "자산총계 계정",
    "liabilities_account": "부채총계 계정",
    "equity_account": "자본총계 계정",
}


ACCOUNT_ID_LABELS = {
    "ifrs-full_Revenue": "영업수익",
    "dart_OperatingRevenue": "영업수익",
    "ifrs-full_ProfitLossFromOperatingActivities": "영업이익",
    "dart_OperatingIncomeLoss": "영업이익",
    "ifrs-full_ProfitLossBeforeTax": "세전이익",
    "ifrs-full_ProfitLossFromContinuingOperationsBeforeTax": "세전이익",
    "ifrs-full_ProfitLoss": "당기순이익",
    "ifrs-full_ProfitLossAttributableToOwnersOfParent": "지배기업 소유주지분 순이익",
    "ifrs-full_Assets": "자산총계",
    "ifrs-full_Liabilities": "부채총계",
    "ifrs-full_Equity": "자본총계(자기자본)",
}


ACCOUNT_NAME_LABELS = {
    "Revenue": "영업수익",
    "OperatingRevenue": "영업수익",
    "ProfitLossFromOperatingActivities": "영업이익",
    "OperatingIncomeLoss": "영업이익",
    "ProfitLossBeforeTax": "세전이익",
    "ProfitLossFromContinuingOperationsBeforeTax": "세전이익",
    "ProfitLoss": "당기순이익",
    "ProfitLossAttributableToOwnersOfParent": "지배기업 소유주지분 순이익",
    "Assets": "자산총계",
    "Liabilities": "부채총계",
    "Equity": "자본총계(자기자본)",
}


def label_column(key: str) -> str:
    return COLUMN_LABELS.get(key, key)


def korean_account_name(account_id: str = "", account_nm: str = "") -> str:
    if account_id in ACCOUNT_ID_LABELS:
        return ACCOUNT_ID_LABELS[account_id]

    name = (account_nm or "").strip()
    if not name:
        return ""
    if name in ACCOUNT_NAME_LABELS:
        return ACCOUNT_NAME_LABELS[name]
    compact = re.sub(r"[\s()]", "", name)
    if compact in ACCOUNT_NAME_LABELS:
        return ACCOUNT_NAME_LABELS[compact]
    if re.search(r"[가-힣]", name):
        return name
    return name


def localize_account_row(row: dict) -> dict:
    account_id = str(row.get("account_id", ""))
    account_nm = str(row.get("account_nm", ""))
    korean_name = korean_account_name(account_id, account_nm)
    if korean_name:
        row["account_nm_ko"] = korean_name
    if account_nm and korean_name and account_nm != korean_name and not re.search(r"[가-힣]", account_nm):
        row["account_nm_original"] = account_nm
        row["account_nm"] = korean_name
    return row
