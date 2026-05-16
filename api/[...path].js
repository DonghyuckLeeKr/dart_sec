import { onRequest } from "../functions/api/[[path]].js";

export default async function handler(req, res) {
  try {
    const request = await toWebRequest(req);
    const response = await onRequest({
      request,
      env: process.env,
      ctx: {}
    });
    await sendWebResponse(res, response);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
  }
}

async function toWebRequest(req) {
  const protocol = headerValue(req.headers["x-forwarded-proto"]) || "https";
  const host = headerValue(req.headers.host) || "localhost";
  let url = new URL(req.url || "/api", `${protocol}://${host}`);

  if (!url.pathname.startsWith("/api/")) {
    const path = catchAllPath(req);
    url = new URL(`/api/${path}${url.search}`, `${protocol}://${host}`);
  }

  const method = req.method || "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
  return new Request(url, {
    method,
    headers: nodeHeadersToWebHeaders(req.headers),
    body
  });
}

function catchAllPath(req) {
  const value = req.query?.path;
  if (Array.isArray(value)) return value.map(encodeURIComponent).join("/");
  if (value) return encodeURIComponent(String(value));
  return "";
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body) || typeof req.body === "string") return req.body;
    return JSON.stringify(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function nodeHeadersToWebHeaders(headers) {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) output.append(key, item);
    } else {
      output.set(key, value);
    }
  }
  return output;
}
