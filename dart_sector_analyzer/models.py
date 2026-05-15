from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Company:
    corp_code: str
    corp_name: str
    stock_code: str = ""
    corp_cls: str = ""


@dataclass(frozen=True)
class Filing:
    corp_code: str
    corp_name: str
    stock_code: str
    report_nm: str
    rcept_no: str
    rcept_dt: str
    corp_cls: str = ""

    @classmethod
    def from_api(cls, row: dict[str, Any]) -> "Filing":
        return cls(
            corp_code=str(row.get("corp_code", "")),
            corp_name=str(row.get("corp_name", "")),
            stock_code=str(row.get("stock_code", "")),
            report_nm=str(row.get("report_nm", "")),
            rcept_no=str(row.get("rcept_no", "")),
            rcept_dt=str(row.get("rcept_dt", "")),
            corp_cls=str(row.get("corp_cls", "")),
        )


@dataclass(frozen=True)
class ReportKind:
    key: str
    code: str
    label: str

