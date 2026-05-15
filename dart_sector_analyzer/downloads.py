from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from typing import Any, Callable

from .analysis import REPORT_KINDS, find_periodic_filing, infer_report_from_name, infer_year_from_report
from .models import Company, Filing
from .opendart import OpenDartClient, OpenDartError


LogFn = Callable[[str], None]


def download_periodic_report_pdfs(
    client: OpenDartClient,
    companies: list[Company],
    years: list[int],
    report_keys: list[str],
    out_dir: str | Path,
    *,
    final: bool = True,
    overwrite: bool = False,
    log: LogFn | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for year in years:
        for report_key in report_keys:
            kind = REPORT_KINDS[report_key]
            for company in companies:
                filing = find_periodic_filing(
                    client,
                    corp_code=company.corp_code,
                    bsns_year=year,
                    report_key=report_key,
                    final=final,
                )
                if not filing:
                    message = f"{company.corp_name} {year} {kind.label}: 접수번호 없음"
                    if log:
                        log(message)
                    results.append(
                        {
                            "corp_code": company.corp_code,
                            "corp_name": company.corp_name,
                            "stock_code": company.stock_code,
                            "bsns_year": str(year),
                            "report_key": report_key,
                            "report_label": kind.label,
                            "report_nm": kind.label,
                            "rcept_no": "",
                            "rcept_dt": "",
                            "dcm_no": "",
                            "pdf_path": "",
                            "download_status": "미확보",
                            "download_message": message,
                            "file_size": "",
                        }
                    )
                    continue

                result = download_filing_pdf(
                    client,
                    filing,
                    out_dir,
                    bsns_year=year,
                    report_key=report_key,
                    report_label=kind.label,
                    overwrite=overwrite,
                    log=log,
                )
                results.append(result)
    return results


def download_filing_pdf(
    client: OpenDartClient,
    filing: Filing,
    out_dir: str | Path,
    *,
    bsns_year: int | None = None,
    report_key: str | None = None,
    report_label: str | None = None,
    overwrite: bool = False,
    log: LogFn | None = None,
) -> dict[str, Any]:
    out_path = _pdf_path(out_dir, filing)
    inferred_report_key = report_key or infer_report_from_name(filing.report_nm) or ""
    inferred_year = bsns_year or infer_year_from_report(filing.report_nm, filing.rcept_dt)
    if report_label is not None:
        inferred_label = report_label
    elif inferred_report_key in REPORT_KINDS:
        inferred_label = REPORT_KINDS[inferred_report_key].label
    else:
        inferred_label = ""

    base_row: dict[str, Any] = {
        "corp_code": filing.corp_code,
        "corp_name": filing.corp_name,
        "stock_code": filing.stock_code,
        "bsns_year": str(inferred_year),
        "report_key": inferred_report_key,
        "report_label": inferred_label,
        "report_nm": filing.report_nm,
        "rcept_no": filing.rcept_no,
        "rcept_dt": filing.rcept_dt,
        "dcm_no": "",
        "pdf_path": str(out_path),
        "download_status": "",
        "download_message": "",
        "file_size": "",
    }

    if out_path.exists() and not overwrite:
        size = out_path.stat().st_size
        if log:
            log(f"이미 있음: {out_path}")
        return {
            **base_row,
            "download_status": "이미 있음",
            "download_message": "같은 파일명이 이미 있어 재다운로드하지 않음",
            "file_size": size,
        }

    try:
        dcm_no, pdf_bytes = fetch_filing_pdf(client, filing.rcept_no)
    except Exception as exc:
        message = f"{filing.corp_name} {filing.report_nm}: PDF 다운로드 실패({exc})"
        if log:
            log(message)
        return {
            **base_row,
            "download_status": "실패",
            "download_message": message,
        }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(pdf_bytes)
    if log:
        log(f"PDF 저장: {out_path}")
    return {
        **base_row,
        "dcm_no": dcm_no,
        "download_status": "다운로드 완료",
        "download_message": "",
        "file_size": len(pdf_bytes),
    }


def fetch_filing_pdf(client: OpenDartClient, rcept_no: str) -> tuple[str, bytes]:
    html = client.dart_viewer_html(rcept_no=rcept_no)
    candidates = pdf_dcm_candidates(html, rcept_no)
    if not candidates:
        raise OpenDartError("DART 뷰어에서 PDF 문서번호(dcm_no)를 찾지 못했습니다.")

    last_error: Exception | None = None
    for dcm_no in candidates:
        try:
            raw = client.dart_pdf(rcept_no=rcept_no, dcm_no=dcm_no)
        except Exception as exc:
            last_error = exc
            continue
        if raw.startswith(b"%PDF-"):
            return dcm_no, raw
        preview = raw[:120].decode("utf-8", errors="replace").replace("\n", " ")
        last_error = OpenDartError(f"dcm_no={dcm_no} 응답이 PDF가 아닙니다: {preview}")
    if last_error:
        raise last_error
    raise OpenDartError("PDF 후보가 모두 실패했습니다.")


def pdf_dcm_candidates(html: str, rcept_no: str) -> list[str]:
    patterns = [
        rf"openPdfDownload\(\s*['\"]?{re.escape(rcept_no)}['\"]?\s*,\s*['\"]?(\d+)['\"]?",
        rf"pdf/download/pdf\.do\?rcp_no={re.escape(rcept_no)}&dcm_no=(\d+)",
        rf"viewDoc\(\s*['\"]{re.escape(rcept_no)}['\"]\s*,\s*['\"](\d+)['\"]",
        r"dcmNo\s*=\s*['\"]?(\d+)",
    ]
    candidates: list[str] = []
    for pattern in patterns:
        for match in re.findall(pattern, html):
            dcm_no = match[0] if isinstance(match, tuple) else match
            if dcm_no not in candidates:
                candidates.append(dcm_no)
    return candidates


def sanitize_filename(value: str, max_length: int = 160) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ._")
    if not cleaned:
        cleaned = "dart_report"
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].rstrip(" ._")
    return cleaned


def _pdf_path(out_dir: str | Path, filing: Filing) -> Path:
    date_prefix = filing.rcept_dt or dt.date.today().strftime("%Y%m%d")
    filename = sanitize_filename(f"{date_prefix}_{filing.corp_name}_{filing.report_nm}_{filing.rcept_no}.pdf")
    return Path(out_dir) / filename
