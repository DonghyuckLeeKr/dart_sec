import unittest

from dart_sector_analyzer.analysis import build_metrics, infer_report_from_name, infer_year_from_report


class AnalysisTests(unittest.TestCase):
    def test_infer_report_from_name(self):
        self.assertEqual(infer_report_from_name("사업보고서 (2025.12)"), "annual")
        self.assertEqual(infer_report_from_name("반기보고서 (2026.06)"), "half")
        self.assertEqual(infer_report_from_name("분기보고서 (2026.03)"), "q1")
        self.assertEqual(infer_report_from_name("분기보고서 (2026.09)"), "q3")

    def test_infer_year_from_report(self):
        self.assertEqual(infer_year_from_report("사업보고서 (2025.12)", "20260320"), 2025)
        self.assertEqual(infer_year_from_report("분기보고서 (2026.03)", "20260515"), 2026)
        self.assertEqual(infer_year_from_report("사업보고서", "20260320"), 2025)

    def test_build_metrics_uses_quarterly_accumulated_amounts_and_yoy(self):
        raw_rows = [
            row("001", "A증권", "2025", "11013", "영업수익", "1,000", "1,000"),
            row("001", "A증권", "2025", "11013", "영업이익", "100", "100"),
            row("001", "A증권", "2025", "11013", "세전이익", "90", "90"),
            row("001", "A증권", "2025", "11013", "당기순이익", "80", "80"),
            row("001", "A증권", "2025", "11013", "자본총계", "2,000", ""),
            row("001", "A증권", "2025", "11013", "부채총계", "4,000", ""),
            row("001", "A증권", "2026", "11013", "영업수익", "700", "1,500"),
            row("001", "A증권", "2026", "11013", "영업이익", "70", "150"),
            row("001", "A증권", "2026", "11013", "법인세비용차감전순이익", "60", "120"),
            row("001", "A증권", "2026", "11013", "당기순이익", "50", "100"),
            row("001", "A증권", "2026", "11013", "자본총계", "2,500", ""),
            row("001", "A증권", "2026", "11013", "부채총계", "5,000", ""),
        ]

        metrics = build_metrics(raw_rows)
        latest = [item for item in metrics if item["bsns_year"] == "2026"][0]

        self.assertEqual(latest["operating_revenue"], 1500)
        self.assertEqual(latest["operating_income"], 150)
        self.assertEqual(latest["pretax_income"], 120)
        self.assertEqual(latest["net_income"], 100)
        self.assertEqual(latest["operating_margin"], 0.1)
        self.assertEqual(latest["debt_ratio"], 2.0)
        self.assertEqual(latest["operating_income_yoy"], 0.5)
        self.assertAlmostEqual(latest["pretax_income_yoy"], 1 / 3)

    def test_build_metrics_derives_operating_revenue_from_components_when_total_missing(self):
        raw_rows = [
            row_with_id("001", "A증권", "2026", "11013", "ifrs-full_FeeAndCommissionIncome", "수수료수익", "10", "10"),
            row_with_id("001", "A증권", "2026", "11013", "ifrs-full_RevenueFromInterest", "이자수익", "20", "20"),
            row_with_id(
                "001",
                "A증권",
                "2026",
                "11013",
                "ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss",
                "당기손익-공정가치측정금융상품관련순손익",
                "30",
                "30",
            ),
            row_with_id("001", "A증권", "2026", "11013", "ifrs-full_ForeignExchangeGain", "외환거래이익", "40", "40"),
            row("001", "A증권", "2026", "11013", "영업이익", "50", "50"),
            row("001", "A증권", "2026", "11013", "당기순이익", "40", "40"),
            row("001", "A증권", "2026", "11013", "자본총계", "100", ""),
        ]

        latest = build_metrics(raw_rows)[0]

        self.assertIsNone(latest["operating_revenue"])
        self.assertEqual(latest["operating_revenue_estimate"], 100)
        self.assertEqual(latest["operating_revenue_estimate_basis"], "구성항목 합산")
        self.assertIsNone(latest["operating_margin"])
        self.assertEqual(latest["operating_margin_estimate"], 0.5)


def row(corp_code, corp_name, year, report_code, account_nm, amount, add_amount):
    return {
        "corp_code": corp_code,
        "corp_name": corp_name,
        "stock_code": "000001",
        "bsns_year": year,
        "reprt_code": report_code,
        "used_fs_div": "CFS",
        "report_label": "1분기보고서",
        "account_nm": account_nm,
        "account_id": "",
        "thstrm_amount": amount,
        "thstrm_add_amount": add_amount,
        "ord": "1",
    }


def row_with_id(corp_code, corp_name, year, report_code, account_id, account_nm, amount, add_amount):
    data = row(corp_code, corp_name, year, report_code, account_nm, amount, add_amount)
    data["account_id"] = account_id
    data["sj_div"] = "CIS"
    return data


if __name__ == "__main__":
    unittest.main()
