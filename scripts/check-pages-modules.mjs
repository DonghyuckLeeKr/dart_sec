import "../functions/api/[[path]].js";
import "../src/index.js";
import { analyzeSector, configPayload, listSectorFilings } from "../functions/lib/analysis.js";
import { pdfDcmCandidates, redactSensitiveText } from "../functions/lib/dart.js";

const config = configPayload();
if (!config.sectors.find((sector) => sector.name === "securities")) {
  throw new Error("securities sector is missing");
}

const candidates = pdfDcmCandidates("openPdfDownload('20260514000887', '11379017');", "20260514000887");
if (candidates[0] !== "11379017") {
  throw new Error("PDF dcm parser failed");
}

if (typeof analyzeSector !== "function" || typeof listSectorFilings !== "function") {
  throw new Error("API modules did not load");
}

const redacted = redactSensitiveText("https://opendart.fss.or.kr/api/list.json?crtfc_key=1234567890123456789012345678901234567890&corp_code=00111722");
if (redacted.includes("1234567890123456789012345678901234567890")) {
  throw new Error("OpenDART key redaction failed");
}

globalThis.fetch = async () => new Response("", {
  status: 302,
  headers: { location: "https://opendart.fss.or.kr/error1.html" }
});
try {
  await (await import("../functions/lib/dart.js")).dartJson("1234567890123456789012345678901234567890", "list.json", {});
  throw new Error("Expected OpenDART redirect error");
} catch (error) {
  if (!String(error.message).includes("OpenDART 오류 페이지")) {
    throw error;
  }
}

console.log("Cloudflare modules OK");
