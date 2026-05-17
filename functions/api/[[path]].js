import { COLUMN_LABELS } from "../lib/constants.js";
import { analyzeSector, configPayload, listSectorFilings } from "../lib/analysis.js";
import { configureDart, fetchPdf, redactSensitiveText, resolveApiKey } from "../lib/dart.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    configureDart(env);
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/?/, "");
    if (request.method === "GET" && route === "config") {
      return json({ ok: true, ...configPayload(), labels: COLUMN_LABELS });
    }

    if (request.method === "GET" && route === "filings") {
      const apiKey = resolveApiKey(env, request);
      const payload = {
        sector: url.searchParams.get("sector") || "securities",
        days: Number(url.searchParams.get("days") || 30),
        limit: Number(url.searchParams.get("limit") || 0),
        final: url.searchParams.get("final") !== "false"
      };
      return json({ ok: true, ...(await listSectorFilings(apiKey, payload)) });
    }

    if (request.method === "POST" && route === "analyze") {
      const apiKey = resolveApiKey(env, request);
      const payload = await request.json();
      return json({ ok: true, ...(await analyzeSector(apiKey, payload)) });
    }

    if (request.method === "GET" && route === "pdf") {
      const rceptNo = url.searchParams.get("rceptNo") || "";
      if (!/^\d{14}$/.test(rceptNo)) {
        return json({ ok: false, error: "접수번호 형식이 올바르지 않습니다." }, 400);
      }
      const fileName = sanitizeFileName(url.searchParams.get("fileName") || `${rceptNo}.pdf`);
      const disposition = url.searchParams.get("inline") === "true" ? "inline" : "attachment";
      const { bytes } = await fetchPdf(rceptNo);
      return new Response(bytes, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "cache-control": "private, max-age=300",
          ...corsHeaders()
        }
      });
    }

    return json({ ok: false, error: "없는 API 경로입니다." }, 404);
  } catch (error) {
    return json({ ok: false, error: redactSensitiveText(error.message || String(error)) }, 500);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-dart-api-key"
  };
}

function sanitizeFileName(value) {
  const cleaned = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.endsWith(".pdf") ? cleaned : `${cleaned || "dart_report"}.pdf`;
}
