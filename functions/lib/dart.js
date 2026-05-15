const DEFAULT_OPEN_DART_BASE = "https://opendart.fss.or.kr/api";
const DART_WEB_BASE = "https://dart.fss.or.kr";

let openDartBase = DEFAULT_OPEN_DART_BASE;
let allowHttpFallback = true;

export function configureDart(env) {
  openDartBase = env?.OPEN_DART_BASE || DEFAULT_OPEN_DART_BASE;
  allowHttpFallback = String(env?.ALLOW_OPEN_DART_HTTP_FALLBACK || "true").toLowerCase() !== "false";
}

export function resolveApiKey(env, request) {
  const fromEnv = env?.DART_API_KEY || env?.OPEN_DART_API_KEY;
  const fromHeader = request.headers.get("x-dart-api-key");
  const key = (fromEnv || fromHeader || "").trim();
  if (!key) {
    throw new Error("DART_API_KEY가 Cloudflare 환경변수에 없고 요청 헤더에도 없습니다.");
  }
  return key;
}

export async function dartJson(apiKey, endpoint, params = {}) {
  const url = new URL(`${openDartBase}/${endpoint}`);
  url.searchParams.set("crtfc_key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json,*/*" }
    });
  } catch (error) {
    if (!allowHttpFallback || !url.protocol.startsWith("https")) {
      throw new Error(`OpenDART 연결 실패: ${error.message}`);
    }
    url.protocol = "http:";
    response = await fetch(url, {
      headers: { accept: "application/json,*/*" }
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenDART HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`OpenDART JSON 파싱 실패: ${text.slice(0, 200)}`);
  }
  const status = String(data.status || "000");
  if (!["000", "013"].includes(status)) {
    throw new Error(`OpenDART status=${status}: ${data.message || "알 수 없는 오류"}`);
  }
  return data;
}

export async function searchDisclosures(apiKey, { corpCode, bgnDe, endDe, final = true, pblntfTy = "A" }) {
  const rows = [];
  let pageNo = 1;
  while (true) {
    const data = await dartJson(apiKey, "list.json", {
      corp_code: corpCode,
      bgn_de: bgnDe,
      end_de: endDe,
      last_reprt_at: final ? "Y" : "N",
      sort: "date",
      sort_mth: "desc",
      page_count: 100,
      page_no: pageNo,
      pblntf_ty: pblntfTy
    });
    for (const row of data.list || []) {
      rows.push({
        corp_code: String(row.corp_code || ""),
        corp_name: String(row.corp_name || ""),
        stock_code: String(row.stock_code || ""),
        report_nm: String(row.report_nm || ""),
        rcept_no: String(row.rcept_no || ""),
        rcept_dt: String(row.rcept_dt || ""),
        corp_cls: String(row.corp_cls || "")
      });
    }
    const totalPage = Number(data.total_page || 1);
    if (pageNo >= totalPage) {
      return rows;
    }
    pageNo += 1;
  }
}

export async function financialStatement(apiKey, { corpCode, bsnsYear, reprtCode, fsDiv }) {
  const data = await dartJson(apiKey, "fnlttSinglAcntAll.json", {
    corp_code: corpCode,
    bsns_year: bsnsYear,
    reprt_code: reprtCode,
    fs_div: fsDiv
  });
  return Array.isArray(data.list) ? data.list : [];
}

export async function xbrlDocument(apiKey, { rceptNo, reprtCode }) {
  const url = new URL(`${openDartBase}/fnlttXbrl.xml`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("rcept_no", rceptNo);
  url.searchParams.set("reprt_code", reprtCode);
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/zip,*/*" }
    });
  } catch (error) {
    if (!allowHttpFallback || !url.protocol.startsWith("https")) {
      throw new Error(`XBRL 다운로드 실패: ${error.message}`);
    }
    url.protocol = "http:";
    response = await fetch(url, {
      headers: { accept: "application/zip,*/*" }
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return bytes;
  }
  const text = new TextDecoder().decode(bytes.slice(0, 500));
  throw new Error(`XBRL ZIP 응답이 아닙니다: ${text}`);
}

export async function dartViewerHtml(rceptNo) {
  const url = new URL(`${DART_WEB_BASE}/dsaf001/main.do`);
  url.searchParams.set("rcpNo", rceptNo);
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 dart-sector-analyzer-pages/0.1" }
  });
  if (!response.ok) {
    throw new Error(`DART 뷰어 HTTP ${response.status}`);
  }
  return response.text();
}

export function pdfDcmCandidates(html, rceptNo) {
  const patterns = [
    new RegExp(`openPdfDownload\\(\\s*['"]?${escapeRegExp(rceptNo)}['"]?\\s*,\\s*['"]?(\\d+)['"]?`, "g"),
    new RegExp(`pdf/download/pdf\\.do\\?rcp_no=${escapeRegExp(rceptNo)}&dcm_no=(\\d+)`, "g"),
    new RegExp(`viewDoc\\(\\s*['"]${escapeRegExp(rceptNo)}['"]\\s*,\\s*['"](\\d+)['"]`, "g"),
    /dcmNo\s*=\s*['"]?(\d+)/g
  ];
  const candidates = [];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (!candidates.includes(match[1])) {
        candidates.push(match[1]);
      }
    }
  }
  return candidates;
}

export async function fetchPdf(rceptNo) {
  const html = await dartViewerHtml(rceptNo);
  const candidates = pdfDcmCandidates(html, rceptNo);
  if (!candidates.length) {
    throw new Error("DART 뷰어에서 PDF 문서번호를 찾지 못했습니다.");
  }
  let lastError = "";
  for (const dcmNo of candidates) {
    const url = new URL(`${DART_WEB_BASE}/pdf/download/pdf.do`);
    url.searchParams.set("rcp_no", rceptNo);
    url.searchParams.set("dcm_no", dcmNo);
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 dart-sector-analyzer-pages/0.1",
        referer: `${DART_WEB_BASE}/dsaf001/main.do?rcpNo=${rceptNo}`
      }
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.ok && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return { dcmNo, bytes };
    }
    lastError = `dcm_no=${dcmNo} 응답이 PDF가 아닙니다.`;
  }
  throw new Error(lastError || "PDF 후보가 모두 실패했습니다.");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
