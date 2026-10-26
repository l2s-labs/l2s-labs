"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const LEADS_WEBHOOK_URL = (process.env.LEADS_WEBHOOK_URL || "").trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const LEADS_TO_EMAIL = (process.env.LEADS_TO_EMAIL || "").trim();
const LEADS_FROM_EMAIL = (
  process.env.LEADS_FROM_EMAIL || "L2S Labs <onboarding@resend.dev>"
).trim();
// Se true, falha de webhook/Resend vira 502. Padrão: aceita o lead e registra no log.
const LEADS_STRICT = /^(1|true|yes)$/i.test(process.env.LEADS_STRICT || "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, data, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(root, normalized);
  if (!full.startsWith(root)) return null;
  return full;
}

function cacheControlFor(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "public, max-age=60, must-revalidate";
  // Sem fingerprint nos assets: cache curto + revalidação
  if ([".css", ".js"].includes(ext)) return "public, max-age=300, must-revalidate";
  if (ext === ".woff2") return "public, max-age=31536000, immutable";
  if ([".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico"].includes(ext)) {
    return "public, max-age=86400";
  }
  return "public, max-age=300";
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatLead(lead) {
  return [
    `Novo lead — L2S Labs`,
    `Nome: ${lead.name}`,
    `E-mail: ${lead.email}`,
    `Telefone: ${lead.phone || "—"}`,
    `Interesse: ${lead.interest || "—"}`,
    `Mensagem: ${lead.message || "—"}`,
    `Recebido em: ${lead.receivedAt}`,
  ].join("\n");
}

async function deliverViaWebhook(text, lead) {
  const response = await fetch(LEADS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: text.slice(0, 1900),
      text,
      lead,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Webhook failed: ${response.status} ${body.slice(0, 300)}`);
  }
  return "webhook";
}

async function deliverViaResend(text, lead) {
  if (!RESEND_API_KEY || !LEADS_TO_EMAIL) {
    throw new Error("Resend incompleto: defina RESEND_API_KEY e LEADS_TO_EMAIL");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: LEADS_FROM_EMAIL,
      to: [LEADS_TO_EMAIL],
      subject: `Lead L2S Labs — ${lead.name}`,
      text,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Resend failed: ${response.status} ${errText.slice(0, 400)}`);
  }
  return "email";
}

async function deliverLead(lead) {
  const text = formatLead(lead);
  // Sempre espelha no log do Railway (útil se e-mail/webhook falhar)
  console.log("[lead]", text);

  if (LEADS_WEBHOOK_URL) {
    await deliverViaWebhook(text, lead);
    return "webhook";
  }

  if (RESEND_API_KEY || LEADS_TO_EMAIL) {
    await deliverViaResend(text, lead);
    return "email";
  }

  return "log";
}

async function handleLeads(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { ok: false, error: err.message });
    return;
  }

  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { ok: false, error: "JSON inválido" });
    return;
  }

  // Honeypot — bots fill hidden fields
  if (data.company || data.website) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const name = String(data.name || "").trim();
  const email = String(data.email || "").trim().toLowerCase();
  const phone = String(data.phone || "").trim();
  const interest = String(data.interest || "").trim();
  const message = String(data.message || "").trim();

  if (name.length < 2 || name.length > 120) {
    sendJson(res, 400, { ok: false, error: "Informe um nome válido." });
    return;
  }
  if (!isEmail(email) || email.length > 200) {
    sendJson(res, 400, { ok: false, error: "Informe um e-mail válido." });
    return;
  }
  if (message.length > 2000) {
    sendJson(res, 400, { ok: false, error: "Mensagem muito longa." });
    return;
  }

  const lead = {
    name,
    email,
    phone: phone.slice(0, 40),
    interest: interest.slice(0, 80),
    message: message.slice(0, 2000),
    receivedAt: new Date().toISOString(),
  };

  try {
    const via = await deliverLead(lead);
    sendJson(res, 200, { ok: true, via });
  } catch (err) {
    console.error("[leads] delivery failed:", err && err.message ? err.message : err);
    if (LEADS_STRICT) {
      sendJson(res, 502, {
        ok: false,
        error: "Não foi possível enviar. Tente novamente.",
        detail: String(err && err.message ? err.message : err).slice(0, 200),
      });
      return;
    }
    // Aceita o lead mesmo se Resend/webhook falhar — fica no log do serviço
    sendJson(res, 200, { ok: true, via: "log", deliveryError: true });
  }
}

function requestOrigin(req) {
  if (SITE_URL) return SITE_URL;
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function buildSitemap(origin) {
  const paths = ["/", "/llms.txt", "/llms-full.txt", "/organization.json", "/og.jpg"];
  const urls = paths
    .map(
      (p) => `  <url>
    <loc>${origin}${p === "/" ? "/" : p}</loc>
    <changefreq>${p === "/" ? "weekly" : "monthly"}</changefreq>
    <priority>${p === "/" ? "1.0" : "0.5"}</priority>
  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function buildRobots(origin) {
  return `# L2S Labs — crawlers humanos e de IA
User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Bytespider
Allow: /

User-agent: cohere-ai
Allow: /

User-agent: Meta-ExternalAgent
Allow: /

# Contexto para LLMs: ${origin}/llms.txt
Sitemap: ${origin}/sitemap.xml
`;
}

function serveStatic(req, res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = safeJoin(PUBLIC_DIR, requestPath);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "Cache-Control": cacheControlFor(filePath),
      "X-Content-Type-Options": "nosniff",
    };
    // Preload de fontes usa mode cors (crossorigin) — mesmo same-origin precisa ACAO
    if (ext === ".woff2") {
      headers["Access-Control-Allow-Origin"] = "*";
    }

    if (requestPath === "/index.html") {
      const origin = requestOrigin(req);
      fs.readFile(filePath, "utf8", (readErr, html) => {
        if (readErr) {
          send(res, 500, "Error reading page");
          return;
        }
        send(res, 200, html.split("{{SITE_URL}}").join(origin), headers);
      });
      return;
    }

    if (requestPath === "/organization.json") {
      const origin = requestOrigin(req);
      fs.readFile(filePath, "utf8", (readErr, raw) => {
        if (readErr) {
          send(res, 500, "Error reading organization");
          return;
        }
        try {
          const data = JSON.parse(raw);
          data.url = origin;
          data.sameAs = data.sameAs || [];
          send(res, 200, `${JSON.stringify(data, null, 2)}\n`, headers);
        } catch {
          send(res, 200, raw, headers);
        }
      });
      return;
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const pathname = url.pathname;

  if (pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/leads") {
    await handleLeads(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (pathname === "/sitemap.xml") {
    const origin = requestOrigin(req);
    send(res, 200, buildSitemap(origin), {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
    return;
  }

  if (pathname === "/robots.txt") {
    const origin = requestOrigin(req);
    send(res, 200, buildRobots(origin), {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  const delivery = LEADS_WEBHOOK_URL
    ? "webhook"
    : RESEND_API_KEY || LEADS_TO_EMAIL
      ? "resend"
      : "log-only";
  console.log(`L2S Labs listening on :${PORT} (leads: ${delivery}, strict: ${LEADS_STRICT})`);
});
