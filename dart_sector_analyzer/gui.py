from __future__ import annotations

import datetime as dt
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

try:
    from PySide6.QtCore import Qt, QThread, QUrl, Signal
    from PySide6.QtGui import QDesktopServices
    from PySide6.QtWidgets import (
        QApplication,
        QCheckBox,
        QComboBox,
        QFormLayout,
        QFrame,
        QGridLayout,
        QGroupBox,
        QHBoxLayout,
        QHeaderView,
        QLabel,
        QLineEdit,
        QMainWindow,
        QMessageBox,
        QPushButton,
        QSpinBox,
        QTabWidget,
        QTableWidget,
        QTableWidgetItem,
        QTextEdit,
        QVBoxLayout,
        QWidget,
    )
except ModuleNotFoundError as exc:  # pragma: no cover - exercised only without PySide6 installed.
    raise RuntimeError("PySide6가 설치되어 있지 않습니다. 먼저 `py -m pip install -r requirements.txt`를 실행하세요.") from exc

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
from .labels import label_column
from .downloads import download_filing_pdf, download_periodic_report_pdfs
from .models import Company, Filing
from .opendart import OpenDartClient
from .sectors import DEFAULT_SECTORS_FILE, list_sector_names, resolve_sector_companies, search_corp_rows


APP_TITLE = "DART 섹터 재무 분석기"

METRIC_COLUMNS = [
    "rank_operating_income",
    "corp_name",
    "stock_code",
    "bsns_year",
    "report_label",
    "fs_div",
    "collection_status",
    "failure_reason",
    "data_source",
    "operating_revenue",
    "operating_revenue_estimate",
    "operating_revenue_basis",
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
]

FILING_COLUMNS = ["rcept_dt", "corp_name", "stock_code", "report_nm", "rcept_no"]

ROW_DATA_ROLE = Qt.UserRole + 1
SORT_VALUE_ROLE = Qt.UserRole


class JobWorker(QThread):
    log = Signal(str)
    succeeded = Signal(object)
    failed = Signal(str)

    def __init__(self, job: Callable[[Callable[[str], None]], Any]) -> None:
        super().__init__()
        self._job = job

    def run(self) -> None:
        try:
            result = self._job(self.log.emit)
            self.succeeded.emit(result)
        except Exception as exc:
            detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            self.failed.emit(detail)


class WatchWorker(QThread):
    log = Signal(str)
    filings_found = Signal(object)
    metrics_found = Signal(object)
    failed = Signal(str)

    def __init__(
        self,
        *,
        api_key: str,
        cache_dir: str,
        request_delay: float,
        sector: str,
        sectors_file: str,
        limit: int | None,
        days: int,
        interval_sec: int,
        final_only: bool,
        fetch_financials: bool,
        fs_div: str,
        fallback_ofs: bool,
        xbrl_fallback: bool,
        out_dir: str,
        refresh_corp_codes: bool,
    ) -> None:
        super().__init__()
        self.api_key = api_key
        self.cache_dir = cache_dir
        self.request_delay = request_delay
        self.sector = sector
        self.sectors_file = sectors_file
        self.limit = limit
        self.days = days
        self.interval_sec = interval_sec
        self.final_only = final_only
        self.fetch_financials = fetch_financials
        self.fs_div = fs_div
        self.fallback_ofs = fallback_ofs
        self.xbrl_fallback = xbrl_fallback
        self.out_dir = out_dir
        self.refresh_corp_codes = refresh_corp_codes
        self._stopping = False

    def stop(self) -> None:
        self._stopping = True

    def run(self) -> None:
        try:
            client = OpenDartClient(api_key=self.api_key or None, cache_dir=self.cache_dir, request_delay=self.request_delay)
            corp_codes = client.corp_codes(refresh=self.refresh_corp_codes)
            companies, warnings = resolve_sector_companies(self.sector, corp_codes, self.sectors_file, self.limit)
            for warning in warnings:
                self.log.emit(f"경고: {warning}")
            if not companies:
                raise ValueError(f"섹터 '{self.sector}'에서 해석 가능한 회사를 찾지 못했습니다.")

            state_path = Path(self.out_dir) / "state" / f"seen_filings_{self.sector}.json"
            seen = load_seen(state_path)
            self.log.emit(f"실시간 감시 시작: {self.sector}, 회사 {len(companies)}개")

            while not self._stopping:
                start = compact_date(dt.date.today() - dt.timedelta(days=self.days))
                end = compact_date(dt.date.today())
                new_filings: list[Filing] = []
                for company in companies:
                    if self._stopping:
                        break
                    filings = client.search_disclosures(
                        corp_code=company.corp_code,
                        bgn_de=start,
                        end_de=end,
                        final=self.final_only,
                        pblntf_ty="A",
                    )
                    for filing in filter_periodic_filings(filings):
                        if filing.rcept_no not in seen:
                            new_filings.append(filing)
                            seen.add(filing.rcept_no)

                if new_filings:
                    rows = [filing.__dict__ for filing in new_filings]
                    self.filings_found.emit(rows)
                    write_json(state_path, sorted(seen))
                    self.log.emit(f"새 정기보고서 {len(new_filings)}건 감지")

                    if self.fetch_financials:
                        metric_rows: list[dict[str, Any]] = []
                        for filing in new_filings:
                            report_key = infer_report_from_name(filing.report_nm)
                            if not report_key:
                                self.log.emit(f"보고서 종류 해석 실패: {filing.report_nm}")
                                continue
                            year = infer_year_from_report(filing.report_nm, filing.rcept_dt)
                            company = Company(corp_code=filing.corp_code, corp_name=filing.corp_name, stock_code=filing.stock_code)
                            raw_rows, warnings = collect_financials(
                                client,
                                [company],
                                [year],
                                [report_key],
                                self.fs_div,
                                self.fallback_ofs,
                                xbrl_fallback=self.xbrl_fallback,
                            )
                            for warning in warnings:
                                self.log.emit(f"경고: {warning}")
                            metric_rows.extend(build_metrics(raw_rows))
                        if metric_rows:
                            self.metrics_found.emit(metric_rows)
                else:
                    self.log.emit("새 공시 없음")

                for _ in range(max(self.interval_sec, 1)):
                    if self._stopping:
                        break
                    self.sleep(1)
            self.log.emit("실시간 감시 중지")
        except Exception as exc:
            detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            self.failed.emit(detail)


class MainWindow(QMainWindow):
    def __init__(self, defaults: dict[str, Any] | None = None) -> None:
        super().__init__()
        self.defaults = defaults or {}
        self.setWindowTitle(APP_TITLE)
        self.resize(1320, 860)
        self.worker: JobWorker | None = None
        self.watch_worker: WatchWorker | None = None
        self.last_output_dir = Path("out").resolve()

        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(10)

        layout.addWidget(self._build_settings())
        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_analysis_tab(), "재무 분석")
        self.tabs.addTab(self._build_filings_tab(), "공시 조회")
        self.tabs.addTab(self._build_company_tab(), "회사 검색")
        layout.addWidget(self.tabs, 1)
        layout.addWidget(self._build_log_panel())

        self._load_sectors()
        self._set_busy(False)

    def _build_settings(self) -> QWidget:
        box = QGroupBox("OpenDART 설정")
        layout = QGridLayout(box)
        layout.setHorizontalSpacing(10)
        layout.setVerticalSpacing(8)

        self.api_key_input = QLineEdit(self.defaults.get("api_key") or load_env_key())
        self.api_key_input.setEchoMode(QLineEdit.Password)
        self.api_key_input.setPlaceholderText("DART_API_KEY 또는 .env 값을 사용합니다")

        self.sectors_file_input = QLineEdit(self.defaults.get("sectors_file") or str(DEFAULT_SECTORS_FILE))
        self.cache_dir_input = QLineEdit(self.defaults.get("cache_dir") or "data/cache")
        self.out_dir_input = QLineEdit("out")
        self.request_delay_input = QLineEdit(str(self.defaults.get("request_delay") or "0.15"))
        self.sector_combo = QComboBox()
        self.refresh_codes_check = QCheckBox("회사 고유번호 새로고침")
        self.limit_spin = QSpinBox()
        self.limit_spin.setRange(0, 1000)
        self.limit_spin.setSpecialValueText("전체")

        self.refresh_codes_button = QPushButton("회사코드 갱신")
        self.refresh_codes_button.clicked.connect(self.refresh_corp_codes)
        self.open_output_button = QPushButton("결과 폴더 열기")
        self.open_output_button.clicked.connect(self.open_output_dir)

        layout.addWidget(QLabel("API Key"), 0, 0)
        layout.addWidget(self.api_key_input, 0, 1, 1, 3)
        layout.addWidget(QLabel("섹터"), 0, 4)
        layout.addWidget(self.sector_combo, 0, 5)
        layout.addWidget(QLabel("처리 회사 수"), 0, 6)
        layout.addWidget(self.limit_spin, 0, 7)

        layout.addWidget(QLabel("섹터 파일"), 1, 0)
        layout.addWidget(self.sectors_file_input, 1, 1)
        layout.addWidget(QLabel("캐시"), 1, 2)
        layout.addWidget(self.cache_dir_input, 1, 3)
        layout.addWidget(QLabel("결과"), 1, 4)
        layout.addWidget(self.out_dir_input, 1, 5)
        layout.addWidget(QLabel("요청 간격"), 1, 6)
        layout.addWidget(self.request_delay_input, 1, 7)

        layout.addWidget(self.refresh_codes_check, 2, 1)
        layout.addWidget(self.refresh_codes_button, 2, 5)
        layout.addWidget(self.open_output_button, 2, 6, 1, 2)
        return box

    def _build_analysis_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)

        controls = QFrame()
        controls_layout = QHBoxLayout(controls)
        controls_layout.setContentsMargins(0, 0, 0, 0)
        controls_layout.setSpacing(8)

        self.years_input = QLineEdit(str(dt.date.today().year - 1))
        self.years_input.setPlaceholderText("예: 2024 2025")
        self.report_checks: dict[str, QCheckBox] = {}
        for key, kind in REPORT_KINDS.items():
            check = QCheckBox(kind.label)
            check.setChecked(key == "annual")
            self.report_checks[key] = check

        self.fs_div_combo = QComboBox()
        self.fs_div_combo.addItems(["CFS", "OFS"])
        self.fallback_ofs_check = QCheckBox("연결 없으면 별도 사용")
        self.fallback_ofs_check.setChecked(True)
        self.xbrl_fallback_check = QCheckBox("API 없으면 XBRL 원문 사용")
        self.xbrl_fallback_check.setChecked(True)
        self.include_raw_check = QCheckBox("원천 CSV 저장")
        self.include_raw_check.setChecked(True)
        self.analyze_button = QPushButton("분석 실행")
        self.analyze_button.clicked.connect(self.run_analysis)
        self.download_report_pdfs_button = QPushButton("보고서 PDF 다운로드")
        self.download_report_pdfs_button.clicked.connect(self.download_report_pdfs)

        controls_layout.addWidget(QLabel("사업연도"))
        controls_layout.addWidget(self.years_input, 1)
        for check in self.report_checks.values():
            controls_layout.addWidget(check)
        controls_layout.addWidget(QLabel("재무제표"))
        controls_layout.addWidget(self.fs_div_combo)
        controls_layout.addWidget(self.fallback_ofs_check)
        controls_layout.addWidget(self.xbrl_fallback_check)
        controls_layout.addWidget(self.include_raw_check)
        controls_layout.addWidget(self.analyze_button)
        controls_layout.addWidget(self.download_report_pdfs_button)

        self.metrics_table = QTableWidget()
        configure_table(self.metrics_table)
        layout.addWidget(controls)
        layout.addWidget(self.metrics_table, 1)
        return page

    def _build_filings_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)

        form = QFrame()
        form_layout = QHBoxLayout(form)
        form_layout.setContentsMargins(0, 0, 0, 0)

        self.days_spin = QSpinBox()
        self.days_spin.setRange(1, 3650)
        self.days_spin.setValue(30)
        self.final_only_check = QCheckBox("최종 보고서만")
        self.final_only_check.setChecked(True)
        self.list_filings_button = QPushButton("최근 공시 조회")
        self.list_filings_button.clicked.connect(self.list_filings)
        self.download_selected_pdf_button = QPushButton("선택 PDF 다운로드")
        self.download_selected_pdf_button.clicked.connect(self.download_selected_filing_pdfs)

        self.watch_interval_spin = QSpinBox()
        self.watch_interval_spin.setRange(10, 86400)
        self.watch_interval_spin.setValue(60)
        self.watch_fetch_check = QCheckBox("감지 시 재무제표 조회")
        self.watch_button = QPushButton("실시간 감시 시작")
        self.watch_button.clicked.connect(self.toggle_watch)

        form_layout.addWidget(QLabel("최근 일수"))
        form_layout.addWidget(self.days_spin)
        form_layout.addWidget(self.final_only_check)
        form_layout.addWidget(self.list_filings_button)
        form_layout.addWidget(self.download_selected_pdf_button)
        form_layout.addSpacing(20)
        form_layout.addWidget(QLabel("감시 주기(초)"))
        form_layout.addWidget(self.watch_interval_spin)
        form_layout.addWidget(self.watch_fetch_check)
        form_layout.addWidget(self.watch_button)
        form_layout.addStretch(1)

        self.filings_table = QTableWidget()
        configure_table(self.filings_table)
        layout.addWidget(form)
        layout.addWidget(self.filings_table, 1)
        return page

    def _build_company_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)

        controls = QFrame()
        controls_layout = QHBoxLayout(controls)
        controls_layout.setContentsMargins(0, 0, 0, 0)
        self.company_query_input = QLineEdit()
        self.company_query_input.setPlaceholderText("회사명, 종목코드, DART 고유번호")
        self.company_query_input.returnPressed.connect(self.search_company)
        self.company_search_button = QPushButton("검색")
        self.company_search_button.clicked.connect(self.search_company)
        controls_layout.addWidget(self.company_query_input, 1)
        controls_layout.addWidget(self.company_search_button)

        self.company_table = QTableWidget()
        configure_table(self.company_table)
        layout.addWidget(controls)
        layout.addWidget(self.company_table, 1)
        return page

    def _build_log_panel(self) -> QWidget:
        box = QGroupBox("작업 로그")
        layout = QVBoxLayout(box)
        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMinimumHeight(120)
        layout.addWidget(self.log_view)
        return box

    def _load_sectors(self) -> None:
        self.sector_combo.clear()
        try:
            self.sector_combo.addItems(list_sector_names(self.sectors_file_input.text()))
        except Exception as exc:
            self.log(f"섹터 파일 로드 실패: {exc}")

    def refresh_corp_codes(self) -> None:
        def job(log: Callable[[str], None]) -> dict[str, Any]:
            client = self.make_client()
            rows = client.corp_codes(refresh=True)
            log(f"회사 고유번호 {len(rows):,}건 갱신 완료")
            return {"count": len(rows)}

        self.run_job(job, lambda _result: self.log("회사코드 갱신 완료"))

    def search_company(self) -> None:
        query = self.company_query_input.text().strip()
        if not query:
            QMessageBox.information(self, APP_TITLE, "검색어를 입력하세요.")
            return

        def job(log: Callable[[str], None]) -> list[dict[str, str]]:
            client = self.make_client()
            rows = client.corp_codes(refresh=self.refresh_codes_check.isChecked())
            matches = search_corp_rows(query, rows, limit=50)
            log(f"회사 검색 결과 {len(matches)}건")
            return matches

        self.run_job(job, lambda rows: set_table_rows(self.company_table, rows, ["corp_code", "corp_name", "stock_code", "modify_date"]))

    def list_filings(self) -> None:
        def job(log: Callable[[str], None]) -> list[dict[str, Any]]:
            client = self.make_client()
            companies, warnings = self.resolve_companies(client)
            for warning in warnings:
                log(f"경고: {warning}")
            start = compact_date(dt.date.today() - dt.timedelta(days=self.days_spin.value()))
            end = compact_date(dt.date.today())
            all_rows: list[dict[str, Any]] = []
            for company in companies:
                filings = client.search_disclosures(
                    corp_code=company.corp_code,
                    bgn_de=start,
                    end_de=end,
                    final=self.final_only_check.isChecked(),
                    pblntf_ty="A",
                )
                all_rows.extend(filing.__dict__ for filing in filter_periodic_filings(filings))
            out_path = Path(self.out_dir_input.text()) / "raw" / f"filings_{self.sector()}_{start}_{end}.csv"
            write_csv(out_path, all_rows)
            self.last_output_dir = Path(self.out_dir_input.text()).resolve()
            log(f"공시 {len(all_rows)}건 저장: {out_path}")
            return all_rows

        self.run_job(job, lambda rows: set_table_rows(self.filings_table, rows, FILING_COLUMNS))

    def run_analysis(self) -> None:
        try:
            years = parse_years(self.years_input.text())
        except ValueError as exc:
            QMessageBox.information(self, APP_TITLE, str(exc))
            return
        reports = [key for key, check in self.report_checks.items() if check.isChecked()]
        if not reports:
            QMessageBox.information(self, APP_TITLE, "보고서 종류를 하나 이상 선택하세요.")
            return

        def job(log: Callable[[str], None]) -> dict[str, Any]:
            client = self.make_client()
            companies, resolve_warnings = self.resolve_companies(client)
            log(f"분석 시작: 회사 {len(companies)}개, 연도 {', '.join(map(str, years))}")
            stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            raw_rows, collect_warnings = collect_financials(
                client=client,
                companies=companies,
                years=years,
                report_keys=reports,
                fs_div=self.fs_div_combo.currentText(),
                fallback_ofs=self.fallback_ofs_check.isChecked(),
                xbrl_fallback=self.xbrl_fallback_check.isChecked(),
            )
            metrics_rows = build_metrics(raw_rows)
            warnings = resolve_warnings + collect_warnings
            coverage_rows = build_coverage_rows(companies, metrics_rows, years, reports, warnings)

            out_root = Path(self.out_dir_input.text())
            raw_path = None
            if self.include_raw_check.isChecked():
                raw_path = out_root / "raw" / f"financials_{self.sector()}_{stamp}.csv"
                write_csv(raw_path, raw_rows)
            metrics_path = out_root / "analysis" / f"metrics_{self.sector()}_{stamp}.csv"
            coverage_path = out_root / "analysis" / f"coverage_{self.sector()}_{stamp}.csv"
            report_path = out_root / "analysis" / f"sector_report_{self.sector()}_{stamp}.md"
            write_csv(metrics_path, metrics_rows)
            write_csv(coverage_path, coverage_rows)
            write_markdown_report(report_path, self.sector(), metrics_rows, warnings)
            self.last_output_dir = out_root.resolve()
            covered = sum(1 for row in coverage_rows if row.get("collection_status") == "수집 완료")
            log(f"분석 완료: 지표 {len(metrics_rows)}행 / 커버리지 {covered}/{len(coverage_rows)}")
            if raw_path:
                log(f"원천 저장: {raw_path}")
            log(f"지표 저장: {metrics_path}")
            log(f"커버리지 저장: {coverage_path}")
            log(f"리포트 저장: {report_path}")
            if warnings:
                log(f"경고 {len(warnings)}건은 리포트 하단에 기록")
            return {"metrics": metrics_rows, "latest": latest_rows(metrics_rows), "coverage": coverage_rows}

        self.run_job(job, lambda result: set_table_rows(self.metrics_table, result["coverage"] or result["latest"] or result["metrics"], METRIC_COLUMNS))

    def download_report_pdfs(self) -> None:
        try:
            years = parse_years(self.years_input.text())
        except ValueError as exc:
            QMessageBox.information(self, APP_TITLE, str(exc))
            return
        reports = [key for key, check in self.report_checks.items() if check.isChecked()]
        if not reports:
            QMessageBox.information(self, APP_TITLE, "보고서 종류를 하나 이상 선택하세요.")
            return

        def job(log: Callable[[str], None]) -> dict[str, Any]:
            client = self.make_client()
            companies, warnings = self.resolve_companies(client)
            for warning in warnings:
                log(f"경고: {warning}")
            stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            out_dir = Path(self.out_dir_input.text()) / "pdf" / f"{self.sector()}_{stamp}"
            log(f"PDF 다운로드 시작: 회사 {len(companies)}개, 연도 {', '.join(map(str, years))}")
            results = download_periodic_report_pdfs(
                client,
                companies,
                years,
                reports,
                out_dir,
                final=True,
                overwrite=False,
                log=log,
            )
            manifest_path = out_dir / "manifest.csv"
            write_csv(manifest_path, results)
            self.last_output_dir = out_dir.resolve()
            downloaded = sum(1 for row in results if row.get("download_status") == "다운로드 완료")
            existing = sum(1 for row in results if row.get("download_status") == "이미 있음")
            failed = sum(1 for row in results if row.get("download_status") in {"실패", "미확보"})
            log(f"PDF 다운로드 완료: 신규 {downloaded}건, 기존 {existing}건, 실패/미확보 {failed}건")
            log(f"PDF 매니페스트 저장: {manifest_path}")
            return {"results": results, "out_dir": out_dir, "manifest_path": manifest_path}

        self.run_job(job, lambda result: self.log(f"PDF 폴더: {result['out_dir']}"))

    def download_selected_filing_pdfs(self) -> None:
        rows = selected_table_rows(self.filings_table)
        if not rows:
            QMessageBox.information(self, APP_TITLE, "공시 조회 결과에서 PDF로 받을 행을 선택하세요.")
            return

        filings = [Filing.from_api(row) for row in rows if row.get("rcept_no")]
        if not filings:
            QMessageBox.information(self, APP_TITLE, "선택한 행에서 접수번호를 찾지 못했습니다.")
            return

        def job(log: Callable[[str], None]) -> dict[str, Any]:
            client = self.make_client()
            stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            out_dir = Path(self.out_dir_input.text()) / "pdf" / f"selected_{stamp}"
            log(f"선택 공시 PDF 다운로드 시작: {len(filings)}건")
            results = [download_filing_pdf(client, filing, out_dir, overwrite=False, log=log) for filing in filings]
            manifest_path = out_dir / "manifest.csv"
            write_csv(manifest_path, results)
            self.last_output_dir = out_dir.resolve()
            downloaded = sum(1 for row in results if row.get("download_status") == "다운로드 완료")
            existing = sum(1 for row in results if row.get("download_status") == "이미 있음")
            failed = sum(1 for row in results if row.get("download_status") == "실패")
            log(f"선택 PDF 다운로드 완료: 신규 {downloaded}건, 기존 {existing}건, 실패 {failed}건")
            log(f"PDF 매니페스트 저장: {manifest_path}")
            return {"results": results, "out_dir": out_dir, "manifest_path": manifest_path}

        self.run_job(job, lambda result: self.log(f"PDF 폴더: {result['out_dir']}"))

    def toggle_watch(self) -> None:
        if self.watch_worker and self.watch_worker.isRunning():
            self.watch_worker.stop()
            self.watch_button.setEnabled(False)
            self.watch_button.setText("중지 중...")
            return

        self.watch_worker = WatchWorker(
            api_key=self.api_key_input.text().strip(),
            cache_dir=self.cache_dir_input.text().strip(),
            request_delay=parse_float(self.request_delay_input.text(), 0.15),
            sector=self.sector(),
            sectors_file=self.sectors_file_input.text().strip(),
            limit=self.limit(),
            days=self.days_spin.value(),
            interval_sec=self.watch_interval_spin.value(),
            final_only=self.final_only_check.isChecked(),
            fetch_financials=self.watch_fetch_check.isChecked(),
            fs_div=self.fs_div_combo.currentText(),
            fallback_ofs=self.fallback_ofs_check.isChecked(),
            xbrl_fallback=self.xbrl_fallback_check.isChecked(),
            out_dir=self.out_dir_input.text().strip(),
            refresh_corp_codes=self.refresh_codes_check.isChecked(),
        )
        self.watch_worker.log.connect(self.log)
        self.watch_worker.filings_found.connect(lambda rows: append_table_rows(self.filings_table, rows, FILING_COLUMNS))
        self.watch_worker.metrics_found.connect(lambda rows: append_table_rows(self.metrics_table, rows, METRIC_COLUMNS))
        self.watch_worker.failed.connect(self.show_error)
        self.watch_worker.finished.connect(self._watch_finished)
        self.watch_worker.start()
        self.watch_button.setText("실시간 감시 중지")

    def _watch_finished(self) -> None:
        self.watch_button.setEnabled(True)
        self.watch_button.setText("실시간 감시 시작")

    def run_job(self, job: Callable[[Callable[[str], None]], Any], on_success: Callable[[Any], None]) -> None:
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, APP_TITLE, "이미 작업이 실행 중입니다.")
            return
        self.worker = JobWorker(job)
        self.worker.log.connect(self.log)
        self.worker.succeeded.connect(on_success)
        self.worker.failed.connect(self.show_error)
        self.worker.finished.connect(lambda: self._set_busy(False))
        self._set_busy(True)
        self.worker.start()

    def make_client(self) -> OpenDartClient:
        return OpenDartClient(
            api_key=self.api_key_input.text().strip() or None,
            cache_dir=self.cache_dir_input.text().strip(),
            request_delay=parse_float(self.request_delay_input.text(), 0.15),
        )

    def resolve_companies(self, client: OpenDartClient) -> tuple[list[Company], list[str]]:
        corp_codes = client.corp_codes(refresh=self.refresh_codes_check.isChecked())
        companies, warnings = resolve_sector_companies(self.sector(), corp_codes, self.sectors_file_input.text(), self.limit())
        if not companies:
            raise ValueError(f"섹터 '{self.sector()}'에서 해석 가능한 회사를 찾지 못했습니다.")
        return companies, warnings

    def sector(self) -> str:
        return self.sector_combo.currentText().strip()

    def limit(self) -> int | None:
        value = self.limit_spin.value()
        return value if value > 0 else None

    def log(self, message: str) -> None:
        stamp = dt.datetime.now().strftime("%H:%M:%S")
        self.log_view.append(f"[{stamp}] {message}")

    def show_error(self, message: str) -> None:
        self.log(f"오류: {message}")
        QMessageBox.critical(self, APP_TITLE, message)

    def open_output_dir(self) -> None:
        path = Path(self.out_dir_input.text() or self.last_output_dir).resolve()
        path.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))

    def _set_busy(self, busy: bool) -> None:
        self.analyze_button.setEnabled(not busy)
        self.list_filings_button.setEnabled(not busy)
        self.download_report_pdfs_button.setEnabled(not busy)
        self.download_selected_pdf_button.setEnabled(not busy)
        self.company_search_button.setEnabled(not busy)
        self.refresh_codes_button.setEnabled(not busy)

    def closeEvent(self, event: Any) -> None:
        if self.watch_worker and self.watch_worker.isRunning():
            self.watch_worker.stop()
            self.watch_worker.wait(3000)
        if self.worker and self.worker.isRunning():
            self.worker.wait(3000)
        super().closeEvent(event)


def run_gui(defaults: dict[str, Any] | None = None) -> int:
    app = QApplication(sys.argv)
    app.setApplicationName(APP_TITLE)
    window = MainWindow(defaults)
    window.show()
    return app.exec()


def configure_table(table: QTableWidget) -> None:
    table.setAlternatingRowColors(True)
    table.setSortingEnabled(True)
    table.horizontalHeader().setStretchLastSection(True)
    table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
    table.verticalHeader().setVisible(False)


def set_table_rows(table: QTableWidget, rows: list[dict[str, Any]], columns: list[str]) -> None:
    table.setSortingEnabled(False)
    table.clear()
    table.setColumnCount(len(columns))
    table.setHorizontalHeaderLabels([label_column(column) for column in columns])
    table.setRowCount(len(rows))
    for r, row in enumerate(rows):
        for c, column in enumerate(columns):
            item = QTableWidgetItem(format_cell(row.get(column)))
            item.setData(ROW_DATA_ROLE, row)
            value = row.get(column)
            if isinstance(value, (int, float)):
                item.setData(SORT_VALUE_ROLE, value)
            table.setItem(r, c, item)
    table.resizeColumnsToContents()
    table.setSortingEnabled(True)


def append_table_rows(table: QTableWidget, rows: list[dict[str, Any]], columns: list[str]) -> None:
    if table.columnCount() != len(columns):
        set_table_rows(table, rows, columns)
        return
    table.setSortingEnabled(False)
    start = table.rowCount()
    table.setRowCount(start + len(rows))
    for idx, row in enumerate(rows, start=start):
        for c, column in enumerate(columns):
            item = QTableWidgetItem(format_cell(row.get(column)))
            item.setData(ROW_DATA_ROLE, row)
            value = row.get(column)
            if isinstance(value, (int, float)):
                item.setData(SORT_VALUE_ROLE, value)
            table.setItem(idx, c, item)
    table.resizeColumnsToContents()
    table.setSortingEnabled(True)


def selected_table_rows(table: QTableWidget) -> list[dict[str, Any]]:
    selected = sorted({index.row() for index in table.selectedIndexes()})
    rows: list[dict[str, Any]] = []
    for row_index in selected:
        item = table.item(row_index, 0)
        data = item.data(ROW_DATA_ROLE) if item else None
        if isinstance(data, dict):
            rows.append(data)
    return rows


def format_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value * 100:.1f}%"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def parse_years(text: str) -> list[int]:
    years = [int(part) for part in text.replace(",", " ").split() if part.strip()]
    if not years:
        raise ValueError("사업연도를 입력하세요.")
    return years


def parse_float(text: str, default: float) -> float:
    try:
        return float(text)
    except ValueError:
        return default


def load_env_key() -> str:
    value = os.getenv("DART_API_KEY") or os.getenv("OPEN_DART_API_KEY")
    if value:
        return value
    env_path = Path(".env")
    if not env_path.exists():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw = stripped.split("=", 1)
        if key.strip() in {"DART_API_KEY", "OPEN_DART_API_KEY"}:
            return raw.strip().strip('"').strip("'")
    return ""


def compact_date(value: dt.date) -> str:
    return value.strftime("%Y%m%d")


def load_seen(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return set(json.loads(path.read_text(encoding="utf-8")))
