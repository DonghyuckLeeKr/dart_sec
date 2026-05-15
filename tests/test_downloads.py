import unittest

from dart_sector_analyzer.downloads import pdf_dcm_candidates, sanitize_filename


class DownloadTests(unittest.TestCase):
    def test_pdf_dcm_candidates_prefers_pdf_download_hook(self):
        html = """
        <script>
          openPdfDownload('20260514000887', '11379017');
          viewDoc("20260514000887", "11379018", "1");
          var dcmNo = "11379019";
        </script>
        """

        self.assertEqual(pdf_dcm_candidates(html, "20260514000887"), ["11379017", "11379018", "11379019"])

    def test_sanitize_filename_removes_windows_invalid_chars(self):
        name = sanitize_filename('20260515_A/B:C*D?E"F<G>H|I.pdf')

        self.assertEqual(name, "20260515_A_B_C_D_E_F_G_H_I.pdf")


if __name__ == "__main__":
    unittest.main()
