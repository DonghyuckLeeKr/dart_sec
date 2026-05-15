from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .models import Company


DEFAULT_SECTORS_FILE = Path("config/sectors.json")


def load_sector_file(path: str | Path = DEFAULT_SECTORS_FILE) -> dict[str, Any]:
    sectors_path = Path(path)
    if not sectors_path.exists():
        raise FileNotFoundError(f"섹터 설정 파일을 찾을 수 없습니다: {sectors_path}")
    return json.loads(sectors_path.read_text(encoding="utf-8"))


def list_sector_names(path: str | Path = DEFAULT_SECTORS_FILE) -> list[str]:
    return sorted(load_sector_file(path).keys())


def resolve_sector_companies(
    sector_name: str,
    corp_codes: list[dict[str, str]],
    sectors_file: str | Path = DEFAULT_SECTORS_FILE,
    limit: int | None = None,
) -> tuple[list[Company], list[str]]:
    sectors = load_sector_file(sectors_file)
    if sector_name not in sectors:
        known = ", ".join(sorted(sectors))
        raise KeyError(f"알 수 없는 섹터입니다: {sector_name}. 사용 가능: {known}")

    warnings: list[str] = []
    companies: list[Company] = []
    entries = sectors[sector_name].get("companies", [])
    if limit:
        entries = entries[:limit]

    by_stock = {row.get("stock_code", ""): row for row in corp_codes if row.get("stock_code")}
    normalized_rows = [(_normalize(row.get("corp_name", "")), row) for row in corp_codes]

    for entry in entries:
        row = _resolve_entry(entry, by_stock, normalized_rows)
        if not row:
            label = entry.get("stock_code") or entry.get("corp_code") or entry.get("name")
            warnings.append(f"회사 해석 실패: {label}")
            continue
        companies.append(
            Company(
                corp_code=row.get("corp_code", ""),
                corp_name=entry.get("display_name") or entry.get("name") or row.get("corp_name", ""),
                stock_code=row.get("stock_code", entry.get("stock_code", "")),
            )
        )

    deduped: dict[str, Company] = {}
    for company in companies:
        deduped[company.corp_code] = company
    return list(deduped.values()), warnings


def search_corp_rows(query: str, corp_codes: list[dict[str, str]], limit: int = 20) -> list[dict[str, str]]:
    normalized_query = _normalize(query)
    if re.fullmatch(r"\d{6}", query):
        exact = [row for row in corp_codes if row.get("stock_code") == query]
        if exact:
            return exact[:limit]
    if re.fullmatch(r"\d{8}", query):
        exact = [row for row in corp_codes if row.get("corp_code") == query]
        if exact:
            return exact[:limit]
    exact_name = [row for row in corp_codes if _normalize(row.get("corp_name", "")) == normalized_query]
    contains = [row for row in corp_codes if normalized_query and normalized_query in _normalize(row.get("corp_name", ""))]
    seen: set[str] = set()
    rows: list[dict[str, str]] = []
    for row in exact_name + contains:
        code = row.get("corp_code", "")
        if code not in seen:
            rows.append(row)
            seen.add(code)
        if len(rows) >= limit:
            break
    return rows


def _resolve_entry(
    entry: dict[str, str],
    by_stock: dict[str, dict[str, str]],
    normalized_rows: list[tuple[str, dict[str, str]]],
) -> dict[str, str] | None:
    corp_code = entry.get("corp_code", "")
    if corp_code:
        for _, row in normalized_rows:
            if row.get("corp_code") == corp_code:
                return row
        return {"corp_code": corp_code, "corp_name": entry.get("name", ""), "stock_code": entry.get("stock_code", "")}

    stock_code = entry.get("stock_code", "")
    if stock_code and stock_code in by_stock:
        return by_stock[stock_code]

    name = entry.get("name", "")
    normalized_name = _normalize(name)
    exact = [row for norm, row in normalized_rows if norm == normalized_name]
    if exact:
        return _prefer_listed(exact)

    contains = [row for norm, row in normalized_rows if normalized_name and normalized_name in norm]
    if contains:
        return _prefer_listed(contains)
    return None


def _prefer_listed(rows: list[dict[str, str]]) -> dict[str, str]:
    listed = [row for row in rows if row.get("stock_code")]
    return sorted(listed or rows, key=lambda row: row.get("corp_name", ""))[0]


def _normalize(value: str) -> str:
    cleaned = re.sub(r"[\s()\[\]{}·.,주식회사㈜]", "", value)
    return cleaned.lower()
