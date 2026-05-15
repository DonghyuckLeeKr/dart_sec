# DART Sector Analyzer

특정 섹터의 사업보고서, 분기보고서, 반기보고서 재무실적을 OpenDART에서 즉시 조회하는 도구입니다. 로컬 CLI/Qt GUI와 Cloudflare Pages용 웹앱을 함께 제공합니다.

## 왜 직접 OpenDART API를 쓰나

확인한 오픈소스 후보는 `dart-fss`, `OpenDartReader`, `opendart-fss`입니다. 재무제표 조회 자체는 잘 지원하지만, 섹터 단위 실시간 감시와 분석 리포트는 프로젝트 요구에 맞춘 얇은 도구가 더 빠르고 통제하기 쉽습니다. 이 프로젝트는 공식 OpenDART 엔드포인트를 직접 호출합니다.

- 공시 목록: `https://opendart.fss.or.kr/api/list.json`
- 회사 고유번호: `https://opendart.fss.or.kr/api/corpCode.xml`
- 전체 재무제표: `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json`

## 준비

OpenDART 인증키를 환경변수로 설정합니다.

```powershell
$env:DART_API_KEY="발급받은_40자리_키"
```

`python` 실행 별칭이 막힌 환경에서는 `py`를 쓰면 됩니다.

## 빠른 실행

```powershell
py -m dart_sector_analyzer refresh-corp-codes
py -m dart_sector_analyzer list-filings --sector securities --days 14
py -m dart_sector_analyzer analyze --sector securities --years 2024 2025 --reports annual q1 half q3
py -m dart_sector_analyzer download-pdfs --sector securities --years 2026 --reports q1
```

## Qt GUI 실행

Qt GUI는 `PySide6`를 사용합니다.

```powershell
py -m pip install -r requirements-desktop.txt
py -m dart_sector_analyzer gui
```

GUI에서는 API 키, 섹터, 사업연도, 보고서 종류, 연결/별도 재무제표 옵션을 화면에서 고른 뒤 `분석 실행`을 누르면 됩니다. 같은 조건의 사업/분기/반기보고서 PDF를 내려받아 수치와 원문을 크로스체크하려면 `보고서 PDF 다운로드`를 누르면 됩니다. `공시 조회` 탭에서는 최근 정기보고서를 조회하거나 `실시간 감시 시작`으로 새 사업/분기/반기보고서를 주기적으로 감지할 수 있고, 조회 결과 행을 선택한 뒤 `선택 PDF 다운로드`로 해당 공시 PDF만 받을 수 있습니다.

기본 분석은 OpenDART 재무제표 API를 먼저 조회하고, 해당 API가 아직 비어 있으면 접수번호를 찾아 `fnlttXbrl.xml` 원문 XBRL에서 영업수익, 영업이익, 당기순이익, 자산, 부채, 자본을 추출합니다. GUI의 `API 없으면 XBRL 원문 사용` 옵션과 CLI의 `--xbrl-fallback` 옵션으로 켜고 끌 수 있습니다.

## Cloudflare Pages 웹앱

팀 내부에서 브라우저로 쓰기 위한 Cloudflare Pages 버전도 들어 있습니다.

- 정적 UI: `public/`
- Pages Functions API: `functions/api/`
- 웹용 분석 로직: `functions/lib/`
- 배포 설정: `wrangler.toml`

로컬 실행:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
notepad .dev.vars
npm run dev
```

`.dev.vars`에는 OpenDART 키를 넣습니다.

```text
DART_API_KEY=발급받은_40자리_키
```

Cloudflare Pages 배포:

```powershell
npm run deploy
```

Cloudflare 대시보드에서는 Pages 프로젝트의 환경변수/Secret에 `DART_API_KEY`를 등록하세요. GitHub 연동 배포를 쓸 때는 빌드 명령을 `npm run check`로 두고, 빌드 출력 디렉터리는 `public`을 사용하면 됩니다. Deploy command에는 `npx wrangler deploy`를 넣지 마세요. GitHub 연동 Pages는 빌드 출력 디렉터리를 기준으로 Pages 배포를 자동 처리하고, 수동 Wrangler 배포가 필요할 때만 `npm run deploy` 또는 `npx wrangler pages deploy public`을 사용합니다.

Cloudflare가 루트의 `pyproject.toml`을 보고 `pip install .`을 실행할 수 있습니다. 이 설치는 데스크톱 GUI 의존성 없이 가볍게 지나가도록 설정되어 있고, Qt GUI가 필요할 때만 로컬에서 `requirements-desktop.txt`를 설치하면 됩니다.

웹앱은 로컬 `out/` 폴더를 만들지 않습니다. 분석 결과와 공시 목록은 화면에서 `CSV`로 내려받고, PDF는 행별 `PDF` 버튼으로 DART 원문을 다운로드합니다. 서버리스 요청 안에서 처리하므로 한 번에 너무 많은 회사와 여러 보고서를 동시에 조회하면 Cloudflare 실행 시간 제한에 걸릴 수 있습니다. 그럴 때는 `처리 회사 수`를 나눠서 돌리면 됩니다.

참고로 일부 Windows 로컬 환경에서는 Wrangler의 workerd 런타임이 `opendart.fss.or.kr` 외부 호출을 `internal error`로 반환할 수 있습니다. 이때는 같은 Pages Functions 코드를 Node 런타임으로 실행하는 로컬 확인용 서버를 쓰면 됩니다.

```powershell
npm run dev:node
```

결과는 기본적으로 `out/` 아래에 저장됩니다.

- `out/raw/financials_*.csv`: DART 원천 재무제표 행
- `out/analysis/metrics_*.csv`: 회사/보고서별 주요 계정과 지표
- `out/analysis/coverage_*.csv`: 섹터 전체 회사별 수집 성공/미확보 상태
- `out/analysis/sector_report_*.md`: 사람이 읽기 쉬운 요약
- `out/pdf/*/*.pdf`: 크로스체크용 DART 보고서 PDF와 `manifest.csv`

## 보고서 PDF 다운로드

재무 API/XBRL에서 가져온 숫자를 원문 보고서와 비교할 수 있도록 DART 웹 뷰어의 접수번호 기준 PDF를 저장합니다. 먼저 OpenDART 공시 목록에서 회사별 사업/분기/반기보고서 접수번호를 찾고, 해당 DART 뷰어 페이지에서 PDF 문서번호를 확인한 뒤 PDF 파일을 내려받습니다.

```powershell
py -m dart_sector_analyzer download-pdfs --sector securities --years 2026 --reports q1 half
```

저장 위치는 `out/pdf/{sector}_{timestamp}/`이며, 어떤 회사가 다운로드/미확보/실패인지 `manifest.csv`에 함께 남깁니다.

## 실시간 감시

아래 명령은 최근 공시를 주기적으로 다시 조회하고 새 정기보고서가 올라오면 콘솔에 표시합니다.

```powershell
py -m dart_sector_analyzer watch --sector securities --interval-sec 60 --days 3
```

새 공시가 감지될 때 해당 보고서 재무제표까지 바로 가져오려면:

```powershell
py -m dart_sector_analyzer watch --sector securities --interval-sec 60 --days 3 --fetch-financials
```

## 섹터 설정

기본 섹터는 `config/sectors.json`에 있습니다. 증권사는 스팩, 펀드, SPC, 해외지점, 과거 합병법인을 제외한 `securities`와 종목코드 중심의 `securities_listed`로 등록되어 있고, 회사는 `stock_code`, `corp_code`, `name` 중 가능한 값으로 해석합니다.

새 섹터를 만들 때:

```json
{
  "my_sector": {
    "description": "관심 섹터",
    "companies": [
      {"name": "삼성전자", "stock_code": "005930"},
      {"name": "SK하이닉스", "stock_code": "000660"}
    ]
  }
}
```

별도 파일을 쓰려면 `--sectors-file`을 지정합니다.

## 주요 옵션

- `--fs-div CFS`: 연결 재무제표 조회. 별도는 `OFS`.
- `--fallback-ofs`: 연결 재무제표가 없으면 별도 재무제표 재시도.
- `--xbrl-fallback`: 재무제표 API가 비어 있으면 공시 접수번호 기반 XBRL 원문에서 핵심 계정 추출.
- `--include-raw`: 분석 리포트와 함께 원천 행 저장.
- `--limit N`: 섹터 내 앞 N개 회사만 테스트.
- `--refresh-corp-codes`: 회사 고유번호 캐시를 강제로 새로 받음.

## 주의

OpenDART는 키별 요청 제한이 있습니다. 대량 섹터를 짧은 주기로 감시할 때는 `--interval-sec`와 `--request-delay`를 보수적으로 잡으세요.
