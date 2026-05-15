from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path
from typing import Any

from .labels import label_column
from .analysis import (
    REPORT_KINDS,
    build_metrics,
    build_coverage_rows,
    collect_financials,
    filter_periodic_filings,
    infer_report_from_name,
    infer_year_from_report,
    latest_rows,
    write_csv,
    write_json,
    write_markdown_report,
)
from .downloads import download_periodic_report_pdfs
from .opendart import OpenDartClient, OpenDartError
from .sectors import DEFAULT_SECTORS_FILE, list_sector_names, resolve_sector_companies, search_corp_rows


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (OpenDartError, FileNotFoundError, KeyError, ValueError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenDART 섹터 재무실적 수집/분석 CLI")
    parser.add_argument("--api-key", help="OpenDART API key. 생략하면 DART_API_KEY/OPEN_DART_API_KEY 사용")
    parser.add_argument("--cache-dir", default="data/cache", help="회사 고유번호 캐시 디렉터리")
    parser.add_argument("--request-delay", type=float, default=0.15, help="OpenDART 요청 간 최소 대기초")
    parser.add_argument("--sectors-file", default=str(DEFAULT_SECTORS_FILE), help="섹터 JSON 설정 파일")

    sub = parser.add_subparsers(dest="command", required=True)

    cmd = sub.add_parser("sectors", help="등록된 섹터 목록 출력")
    cmd.set_defaults(func=cmd_sectors)

    cmd = sub.add_parser("gui", help="Qt GUI 실행")
    cmd.set_defaults(func=cmd_gui)

    cmd = sub.add_parser("refresh-corp-codes", help="OpenDART 회사 고유번호 캐시 갱신")
    cmd.set_defaults(func=cmd_refresh_corp_codes)

    cmd = sub.add_parser("search-corp", help="회사명/종목코드/고유번호 검색")
    cmd.add_argument("query")
    cmd.add_argument("--limit", type=int, default=20)
    cmd.add_argument("--refresh-corp-codes", action="store_true")
    cmd.set_defaults(func=cmd_search_corp)

    cmd = sub.add_parser("list-filings", help="섹터 정기보고서 공시 목록 조회")
    add_sector_args(cmd)
    cmd.add_argument("--days", type=int, default=30, help="오늘부터 과거 N일")
    cmd.add_argument("--start", help="YYYYMMDD 또는 YYYY-MM-DD")
    cmd.add_argument("--end", help="YYYYMMDD 또는 YYYY-MM-DD")
    cmd.add_argument("--final", action=argparse.BooleanOptionalAction, default=True, help="최종 보고서만 조회")
    cmd.add_argument("--out", default="out", help="결과 저장 루트")
    cmd.set_defaults(func=cmd_list_filings)

    cmd = sub.add_parser("analyze", help="섹터 재무제표 수집 후 분석 리포트 생성")
    add_sector_args(cmd)
    cmd.add_argument("--years", type=int, nargs="+", default=[dt.date.today().year - 1], help="사업연도 목록")
    cmd.add_argument("--reports", nargs="+", choices=sorted(REPORT_KINDS), default=["annual"], help="보고서 종류")
    cmd.add_argument("--fs-div", choices=["CFS", "OFS"], default="CFS", help="연결(CFS) 또는 별도(OFS)")
    cmd.add_argument("--fallback-ofs", action="store_true", help="CFS가 없으면 OFS 재시도")
    cmd.add_argument("--xbrl-fallback", action=argparse.BooleanOptionalAction, default=True, help="재무제표 API가 비어 있으면 접수번호 기반 XBRL 원문에서 핵심 계정 추출")
    cmd.add_argument("--out", default="out", help="결과 저장 루트")
    cmd.add_argument("--include-raw", action=argparse.BooleanOptionalAction, default=True, help="원천 재무제표 CSV 저장")
    cmd.set_defaults(func=cmd_analyze)

    cmd = sub.add_parser("download-pdfs", help="섹터 정기보고서 PDF 다운로드")
    add_sector_args(cmd)
    cmd.add_argument("--years", type=int, nargs="+", default=[dt.date.today().year], help="사업연도 목록")
    cmd.add_argument("--reports", nargs="+", choices=sorted(REPORT_KINDS), default=["annual"], help="보고서 종류")
    cmd.add_argument("--final", action=argparse.BooleanOptionalAction, default=True, help="최종 보고서만 조회")
    cmd.add_argument("--out", default="out", help="결과 저장 루트")
    cmd.add_argument("--overwrite", action="store_true", help="이미 받은 PDF도 다시 다운로드")
    cmd.set_defaults(func=cmd_download_pdfs)

    cmd = sub.add_parser("watch", help="섹터 정기보고서 실시간 폴링")
    add_sector_args(cmd)
    cmd.add_argument("--interval-sec", type=int, default=60, help="폴링 주기")
    cmd.add_argument("--days", type=int, default=3, help="매번 조회할 최근 N일")
    cmd.add_argument("--final", action=argparse.BooleanOptionalAction, default=True)
    cmd.add_argument("--fetch-financials", action="store_true", help="새 공시 감지 시 재무제표도 즉시 조회")
    cmd.add_argument("--fs-div", choices=["CFS", "OFS"], default="CFS")
    cmd.add_argument("--fallback-ofs", action="store_true")
    cmd.add_argument("--xbrl-fallback", action=argparse.BooleanOptionalAction, default=True)
    cmd.add_argument("--out", default="out")
    cmd.set_defaults(func=cmd_watch)

    return parser


def add_sector_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--sector", required=True, help="config/sectors.json의 섹터명")
    parser.add_argument("--limit", type=int, help="섹터 내 앞 N개 회사만 처리")
    parser.add_argument("--refresh-corp-codes", action="store_true", help="회사 고유번호 캐시 강제 갱신")


def cmd_sectors(args: argparse.Namespace) -> int:
    for name in list_sector_names(args.sectors_file):
        print(name)
    return 0


def cmd_gui(args: argparse.Namespace) -> int:
    from .gui import run_gui

    return run_gui(
        {
            "api_key": args.api_key,
            "cache_dir": args.cache_dir,
            "request_delay": args.request_delay,
            "sectors_file": args.sectors_file,
        }
    )


def cmd_refresh_corp_codes(args: argparse.Namespace) -> int:
    client = make_client(args)
    rows = client.corp_codes(refresh=True)
    print(f"회사 고유번호 {len(rows):,}건 갱신 완료: {Path(args.cache_dir) / 'corp_codes.json'}")
    return 0


def cmd_search_corp(args: argparse.Namespace) -> int:
    client = make_client(args)
    rows = client.corp_codes(refresh=args.refresh_corp_codes)
    matches = search_corp_rows(args.query, rows, limit=args.limit)
    if not matches:
        print("검색 결과 없음")
        return 0
    print_table(matches, ["corp_code", "corp_name", "stock_code", "modify_date"])
    return 0


def cmd_list_filings(args: argparse.Namespace) -> int:
    client = make_client(args)
    companies, warnings = resolve_companies(args, client)
    start, end = date_range(args)
    all_rows: list[dict[str, Any]] = []
    for company in companies:
        filings = client.search_disclosures(corp_code=company.corp_code, bgn_de=start, end_de=end, final=args.final, pblntf_ty="A")
        for filing in filter_periodic_filings(filings):
            all_rows.append(filing.__dict__)

    out_path = Path(args.out) / "raw" / f"filings_{args.sector}_{start}_{end}.csv"
    write_csv(out_path, all_rows)
    if warnings:
        for warning in warnings:
            print(f"경고: {warning}", file=sys.stderr)
    if all_rows:
        print_table(all_rows, ["rcept_dt", "corp_name", "stock_code", "report_nm", "rcept_no"])
    print(f"저장: {out_path}")
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    client = make_client(args)
    companies, resolve_warnings = resolve_companies(args, client)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    raw_rows, collect_warnings = collect_financials(
        client=client,
        companies=companies,
        years=args.years,
        report_keys=args.reports,
        fs_div=args.fs_div,
        fallback_ofs=args.fallback_ofs,
        xbrl_fallback=args.xbrl_fallback,
    )
    metrics_rows = build_metrics(raw_rows)
    warnings = resolve_warnings + collect_warnings
    coverage_rows = build_coverage_rows(companies, metrics_rows, args.years, args.reports, warnings)

    out_root = Path(args.out)
    if args.include_raw:
        raw_path = out_root / "raw" / f"financials_{args.sector}_{stamp}.csv"
        write_csv(raw_path, raw_rows)
        print(f"원천 저장: {raw_path}")

    metrics_path = out_root / "analysis" / f"metrics_{args.sector}_{stamp}.csv"
    coverage_path = out_root / "analysis" / f"coverage_{args.sector}_{stamp}.csv"
    report_path = out_root / "analysis" / f"sector_report_{args.sector}_{stamp}.md"
    write_csv(metrics_path, metrics_rows)
    write_csv(coverage_path, coverage_rows)
    write_markdown_report(report_path, args.sector, metrics_rows, warnings)

    latest = latest_rows(metrics_rows)
    if latest:
        print_table(
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
            ],
        )
    else:
        print("분석 가능한 재무제표 데이터가 없습니다.")
    covered = sum(1 for row in coverage_rows if row.get("collection_status") == "수집 완료")
    print(f"수집 커버리지: {covered}/{len(coverage_rows)}")
    print(f"지표 저장: {metrics_path}")
    print(f"커버리지 저장: {coverage_path}")
    print(f"리포트 저장: {report_path}")
    if warnings:
        print(f"경고 {len(warnings)}건은 리포트 하단에 기록했습니다.")
    return 0


def cmd_download_pdfs(args: argparse.Namespace) -> int:
    client = make_client(args)
    companies, warnings = resolve_companies(args, client)
    for warning in warnings:
        print(f"경고: {warning}", file=sys.stderr)

    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out) / "pdf" / f"{args.sector}_{stamp}"
    results = download_periodic_report_pdfs(
        client,
        companies,
        args.years,
        args.reports,
        out_dir,
        final=args.final,
        overwrite=args.overwrite,
        log=print,
    )
    manifest_path = out_dir / "manifest.csv"
    write_csv(manifest_path, results)

    print_table(
        results,
        [
            "download_status",
            "corp_name",
            "stock_code",
            "bsns_year",
            "report_label",
            "rcept_dt",
            "rcept_no",
            "dcm_no",
            "pdf_path",
            "download_message",
        ],
    )
    downloaded = sum(1 for row in results if row.get("download_status") == "다운로드 완료")
    existing = sum(1 for row in results if row.get("download_status") == "이미 있음")
    failed = sum(1 for row in results if row.get("download_status") in {"실패", "미확보"})
    print(f"PDF 결과: 다운로드 {downloaded}건, 기존 {existing}건, 실패/미확보 {failed}건")
    print(f"매니페스트 저장: {manifest_path}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    client = make_client(args)
    companies, warnings = resolve_companies(args, client)
    for warning in warnings:
        print(f"경고: {warning}", file=sys.stderr)

    state_path = Path(args.out) / "state" / f"seen_filings_{args.sector}.json"
    seen = load_seen(state_path)
    print(f"감시 시작: sector={args.sector}, companies={len(companies)}, interval={args.interval_sec}s")
    while True:
        start = compact_date(dt.date.today() - dt.timedelta(days=args.days))
        end = compact_date(dt.date.today())
        new_filings = []
        for company in companies:
            filings = client.search_disclosures(corp_code=company.corp_code, bgn_de=start, end_de=end, final=args.final, pblntf_ty="A")
            for filing in filter_periodic_filings(filings):
                if filing.rcept_no not in seen:
                    new_filings.append(filing)
                    seen.add(filing.rcept_no)

        if new_filings:
            now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            print(f"[{now}] 새 정기보고서 {len(new_filings)}건")
            for filing in new_filings:
                print(f"- {filing.rcept_dt} {filing.corp_name} {filing.report_nm} {filing.rcept_no}")
                if args.fetch_financials:
                    fetch_new_filing_financials(client, filing, args)
            write_json(state_path, sorted(seen))
        else:
            print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] 새 공시 없음")
        time.sleep(args.interval_sec)


def fetch_new_filing_financials(client: OpenDartClient, filing: Any, args: argparse.Namespace) -> None:
    report_key = infer_report_from_name(filing.report_nm)
    if not report_key:
        print(f"  재무제표 조회 생략: 보고서 종류 해석 실패")
        return
    year = infer_year_from_report(filing.report_nm, filing.rcept_dt)
    company = type("CompanyProxy", (), {"corp_code": filing.corp_code, "corp_name": filing.corp_name, "stock_code": filing.stock_code})()
    raw_rows, warnings = collect_financials(
        client,
        [company],
        [year],
        [report_key],
        args.fs_div,
        args.fallback_ofs,
        xbrl_fallback=getattr(args, "xbrl_fallback", True),
    )
    metrics_rows = build_metrics(raw_rows)
    if metrics_rows:
        print_table(
            metrics_rows,
            [
                "corp_name",
                "bsns_year",
                "report_label",
                "operating_revenue",
                "operating_revenue_estimate",
                "operating_income",
                "pretax_income",
                "net_income",
                "equity",
                "operating_margin",
                "operating_margin_estimate",
                "roe",
            ],
        )
    for warning in warnings:
        print(f"  경고: {warning}")


def make_client(args: argparse.Namespace) -> OpenDartClient:
    return OpenDartClient(api_key=args.api_key, cache_dir=args.cache_dir, request_delay=args.request_delay)


def resolve_companies(args: argparse.Namespace, client: OpenDartClient):
    corp_codes = client.corp_codes(refresh=args.refresh_corp_codes)
    companies, warnings = resolve_sector_companies(args.sector, corp_codes, args.sectors_file, args.limit)
    if not companies:
        raise ValueError(f"섹터 '{args.sector}'에서 해석 가능한 회사를 찾지 못했습니다.")
    return companies, warnings


def date_range(args: argparse.Namespace) -> tuple[str, str]:
    if args.start and args.end:
        return normalize_date(args.start), normalize_date(args.end)
    end = normalize_date(args.end) if args.end else compact_date(dt.date.today())
    if args.start:
        start = normalize_date(args.start)
    else:
        end_date = parse_compact_date(end)
        start = compact_date(end_date - dt.timedelta(days=args.days))
    return start, end


def normalize_date(value: str) -> str:
    digits = "".join(ch for ch in value if ch.isdigit())
    if len(digits) != 8:
        raise ValueError(f"날짜는 YYYYMMDD 또는 YYYY-MM-DD 형식이어야 합니다: {value}")
    return digits


def compact_date(value: dt.date) -> str:
    return value.strftime("%Y%m%d")


def parse_compact_date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y%m%d").date()


def load_seen(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return set(json.loads(path.read_text(encoding="utf-8")))


def print_table(rows: list[dict[str, Any]], columns: list[str]) -> None:
    if not rows:
        print("(empty)")
        return
    visible = [column for column in columns if any(column in row for row in rows)]
    widths = {column: max(len(label_column(column)), *(len(format_value(row.get(column))) for row in rows)) for column in visible}
    print("  ".join(label_column(column).ljust(widths[column]) for column in visible))
    print("  ".join("-" * widths[column] for column in visible))
    for row in rows:
        print("  ".join(format_value(row.get(column)).ljust(widths[column]) for column in visible))


def format_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value * 100:.1f}%"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)
