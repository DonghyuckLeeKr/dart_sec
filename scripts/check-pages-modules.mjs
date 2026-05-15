import "../functions/api/[[path]].js";
import { analyzeSector, configPayload, listSectorFilings } from "../functions/lib/analysis.js";
import { pdfDcmCandidates } from "../functions/lib/dart.js";

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

console.log("Cloudflare Pages modules OK");
