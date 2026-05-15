import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onRequest } from "../functions/api/[[path]].js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || process.argv[2] || 8787);
const env = loadEnv();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith("/api/")) {
      const body = await readRequestBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: body.length && req.method !== "GET" && req.method !== "HEAD" ? body : undefined
      });
      const response = await onRequest({ request, env });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const arrayBuffer = await response.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
      return;
    }

    const filePath = staticPath(url.pathname);
    const content = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(content);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.message || String(error));
  }
});

server.listen(port, () => {
  console.log(`DART Sector Analyzer web app: http://127.0.0.1:${port}`);
});

function staticPath(pathname) {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = clean ? path.join(publicDir, clean) : path.join(publicDir, "index.html");
  const normalized = path.normalize(target);
  if (!normalized.startsWith(publicDir)) {
    throw Object.assign(new Error("Invalid path"), { code: "ENOENT" });
  }
  return existsSync(normalized) ? normalized : path.join(publicDir, "index.html");
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function loadEnv() {
  const values = {};
  for (const fileName of [".env", ".dev.vars"]) {
    const filePath = path.join(root, fileName);
    if (!existsSync(filePath)) continue;
    const text = Buffer.from(readFileSync(filePath)).toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      values[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
  return { ...process.env, ...values };
}
