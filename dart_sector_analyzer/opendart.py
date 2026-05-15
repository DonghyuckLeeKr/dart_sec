from __future__ import annotations

import io
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .models import Filing


BASE_URL = "https://opendart.fss.or.kr/api"
DART_WEB_URL = "https://dart.fss.or.kr"


class OpenDartError(RuntimeError):
    """Raised when OpenDART returns an error status."""


class OpenDartClient:
    def __init__(
        self,
        api_key: str | None = None,
        cache_dir: str | Path = "data/cache",
        request_delay: float = 0.15,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key or os.getenv("DART_API_KEY") or os.getenv("OPEN_DART_API_KEY") or _load_api_key_from_dotenv()
        if not self.api_key:
            raise OpenDartError("DART_API_KEY 환경변수가 없고 --api-key도 지정되지 않았습니다.")
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.request_delay = request_delay
        self.timeout = timeout
        self._last_request_at = 0.0

    def _pace(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.request_delay:
            time.sleep(self.request_delay - elapsed)
        self._last_request_at = time.monotonic()

    def _open(self, url: str, params: dict[str, Any]) -> bytes:
        payload = {"crtfc_key": self.api_key, **params}
        query = urllib.parse.urlencode(payload)
        request = urllib.request.Request(f"{url}?{query}", headers={"User-Agent": "dart-sector-analyzer/0.1"})
        self._pace()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise OpenDartError(f"HTTP {exc.code}: {body[:300]}") from exc
        except urllib.error.URLError as exc:
            raise OpenDartError(f"OpenDART 연결 실패: {exc}") from exc

    def _open_web(self, url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> bytes:
        query = urllib.parse.urlencode(params or {})
        full_url = f"{url}?{query}" if query else url
        request_headers = {
            "User-Agent": "Mozilla/5.0 dart-sector-analyzer/0.1",
            "Accept": "*/*",
        }
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(full_url, headers=request_headers)
        self._pace()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise OpenDartError(f"DART 웹 HTTP {exc.code}: {body[:300]}") from exc
        except urllib.error.URLError as exc:
            raise OpenDartError(f"DART 웹 연결 실패: {exc}") from exc

    def _json(self, endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
        raw = self._open(f"{BASE_URL}/{endpoint}", params)
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise OpenDartError(f"JSON 파싱 실패: {raw[:300]!r}") from exc

        status = str(data.get("status", "000"))
        if status not in {"000", "013"}:
            message = data.get("message", "알 수 없는 오류")
            raise OpenDartError(f"OpenDART status={status}: {message}")
        return data

    def corp_codes(self, refresh: bool = False) -> list[dict[str, str]]:
        cache_path = self.cache_dir / "corp_codes.json"
        if cache_path.exists() and not refresh:
            return json.loads(cache_path.read_text(encoding="utf-8"))

        raw = self._open(f"{BASE_URL}/corpCode.xml", {})
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            xml_name = next((name for name in archive.namelist() if name.upper().endswith(".XML")), None)
            if not xml_name:
                raise OpenDartError("corpCode.xml ZIP 안에서 XML 파일을 찾지 못했습니다.")
            xml_bytes = archive.read(xml_name)

        root = ElementTree.fromstring(xml_bytes)
        rows: list[dict[str, str]] = []
        for item in root.findall("list"):
            rows.append(
                {
                    "corp_code": _text(item, "corp_code"),
                    "corp_name": _text(item, "corp_name"),
                    "corp_eng_name": _text(item, "corp_eng_name"),
                    "stock_code": _text(item, "stock_code"),
                    "modify_date": _text(item, "modify_date"),
                }
            )
        cache_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        return rows

    def search_disclosures(
        self,
        *,
        corp_code: str | None = None,
        bgn_de: str,
        end_de: str,
        final: bool = True,
        pblntf_ty: str | None = "A",
        page_count: int = 100,
    ) -> list[Filing]:
        params: dict[str, Any] = {
            "bgn_de": bgn_de,
            "end_de": end_de,
            "last_reprt_at": "Y" if final else "N",
            "sort": "date",
            "sort_mth": "desc",
            "page_count": min(max(page_count, 1), 100),
            "page_no": 1,
        }
        if corp_code:
            params["corp_code"] = corp_code
        if pblntf_ty:
            params["pblntf_ty"] = pblntf_ty

        filings: list[Filing] = []
        while True:
            data = self._json("list.json", params)
            filings.extend(Filing.from_api(row) for row in data.get("list", []))
            total_page = int(data.get("total_page") or 1)
            page_no = int(params["page_no"])
            if page_no >= total_page:
                return filings
            params["page_no"] = page_no + 1

    def financial_statement(
        self,
        *,
        corp_code: str,
        bsns_year: int | str,
        reprt_code: str,
        fs_div: str = "CFS",
    ) -> list[dict[str, Any]]:
        data = self._json(
            "fnlttSinglAcntAll.json",
            {
                "corp_code": corp_code,
                "bsns_year": str(bsns_year),
                "reprt_code": reprt_code,
                "fs_div": fs_div,
            },
        )
        return list(data.get("list", []))

    def xbrl_document(self, *, rcept_no: str, reprt_code: str) -> bytes:
        raw = self._open(f"{BASE_URL}/fnlttXbrl.xml", {"rcept_no": rcept_no, "reprt_code": reprt_code})
        if raw.startswith(b"PK"):
            return raw
        try:
            root = ElementTree.fromstring(raw)
            status = root.findtext("status") or ""
            message = root.findtext("message") or raw[:300].decode("utf-8", errors="replace")
            raise OpenDartError(f"OpenDART XBRL status={status}: {message}")
        except ElementTree.ParseError as exc:
            raise OpenDartError(f"XBRL ZIP 응답이 아닙니다: {raw[:300]!r}") from exc

    def dart_viewer_html(self, *, rcept_no: str) -> str:
        raw = self._open_web(f"{DART_WEB_URL}/dsaf001/main.do", {"rcpNo": rcept_no})
        return raw.decode("utf-8", errors="replace")

    def dart_pdf(self, *, rcept_no: str, dcm_no: str) -> bytes:
        return self._open_web(
            f"{DART_WEB_URL}/pdf/download/pdf.do",
            {"rcp_no": rcept_no, "dcm_no": dcm_no},
            headers={"Referer": f"{DART_WEB_URL}/dsaf001/main.do?rcpNo={rcept_no}"},
        )


def _text(item: ElementTree.Element, tag: str) -> str:
    node = item.find(tag)
    return (node.text or "").strip() if node is not None else ""


def _load_api_key_from_dotenv(path: str | Path = ".env") -> str | None:
    env_path = Path(path)
    if not env_path.exists():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() in {"DART_API_KEY", "OPEN_DART_API_KEY"}:
            return value.strip().strip('"').strip("'") or None
    return None
