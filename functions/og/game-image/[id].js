const DEFAULT_GAME_IMAGE_PATH = "/img/logo.png";

function cleanEnv(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/^['"]+|['"]+$/g, "").trim();
}

function normalizeSupabaseUrl(primary, fallback = "") {
  const first = cleanEnv(primary);
  const second = cleanEnv(fallback);
  const candidate = first || second;
  if (!candidate) return "";
  if (candidate.startsWith("ttps://")) return `h${candidate}`;
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) return candidate;
  if (second && (second.startsWith("http://") || second.startsWith("https://"))) return second;
  return candidate;
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function isHttpUrl(value) {
  if (!value) return false;
  return /^https?:\/\//i.test(String(value));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeImageUrl(raw, siteUrl) {
  if (!raw) return "";
  const value = String(raw).trim();
  if (!value) return "";
  if (isHttpUrl(value)) return value;
  const base = stripTrailingSlash(siteUrl);
  if (!base) return "";
  if (value.startsWith("/")) return `${base}${value}`;
  return `${base}/${value}`;
}

async function fetchGame({ supabaseUrl, supabaseAnonKey, gameId }) {
  const encodedId = encodeURIComponent(gameId);
  const endpoint = `${stripTrailingSlash(supabaseUrl)}/rest/v1/servers?id=eq.${encodedId}&select=id,name,banner_url&limit=1`;

  let response = await fetch(endpoint, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    response = await fetch(endpoint, {
      headers: {
        apikey: supabaseAnonKey,
        Accept: "application/json",
      },
    });
  }
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Supabase servers query failed (${response.status}): ${payload}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function wrapTitle(text, maxLineLength = 24, maxLines = 2) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalized) return ["Game no Gimerr"];
  const words = normalized.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLineLength) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  const consumedLength = lines.join(" ").length;
  if (consumedLength < normalized.length && lines.length > 0) {
    const lastIndex = lines.length - 1;
    let lastLine = lines[lastIndex];
    if (lastLine.length > maxLineLength - 1) {
      lastLine = lastLine.slice(0, maxLineLength - 1).trimEnd();
    }
    lines[lastIndex] = `${lastLine}…`;
  }

  return lines.slice(0, maxLines);
}

function uint8ToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageAsDataUrl(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") || "image/png";
  const buffer = await response.arrayBuffer();
  const base64 = uint8ToBase64(buffer);
  return `data:${contentType};base64,${base64}`;
}

function buildSvg({ title, logoDataUrl }) {
  const lines = wrapTitle(title);
  const titleY = lines.length > 1 ? 442 : 462;
  const lineHeight = 54;
  const textNodes = lines.map((line, index) => `
    <text x="600" y="${titleY + (index * lineHeight)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700" fill="#101a2e">${escapeHtml(line)}</text>
  `).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeHtml(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="100%" stop-color="#f4f8ff" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)" />
  <circle cx="1030" cy="90" r="120" fill="rgba(29,78,216,0.10)" />
  <circle cx="140" cy="560" r="180" fill="rgba(14,165,233,0.08)" />
  <rect x="420" y="76" width="360" height="240" rx="28" fill="#ffffff" stroke="#d7e2f4" stroke-width="3" />
  <image href="${logoDataUrl}" x="450" y="106" width="300" height="180" preserveAspectRatio="xMidYMid meet" />
  ${textNodes}
  <text x="600" y="574" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="600" fill="#516081">gimerr.com</text>
</svg>`;
}

export async function onRequestGet(context) {
  const gameId = context.params?.id;
  const supabaseUrl = normalizeSupabaseUrl(context.env.SUPABASE_URL, context.env.PROJECT_URL);
  const supabaseAnonKey = cleanEnv(context.env.SUPABASE_ANON_KEY);
  const siteUrl = stripTrailingSlash(cleanEnv(context.env.SITE_URL) || new URL(context.request.url).origin);

  if (!gameId) {
    return new Response("Game ID ausente.", { status: 400 });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response("SUPABASE_URL/SUPABASE_ANON_KEY não configuradas no Pages.", { status: 500 });
  }

  try {
    const game = await fetchGame({ supabaseUrl, supabaseAnonKey, gameId });
    const title = String(game?.name || "Game no Gimerr").trim() || "Game no Gimerr";
    const sourceImageUrl = normalizeImageUrl(game?.banner_url || DEFAULT_GAME_IMAGE_PATH, siteUrl);
    const logoDataUrl = await fetchImageAsDataUrl(sourceImageUrl);
    const svg = buildSvg({ title, logoDataUrl });

    return new Response(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("OG game image route error:", err);
    const fallbackImageUrl = normalizeImageUrl(DEFAULT_GAME_IMAGE_PATH, siteUrl);
    try {
      const logoDataUrl = await fetchImageAsDataUrl(fallbackImageUrl);
      const svg = buildSvg({ title: "Gimerr", logoDataUrl });
      return new Response(svg, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    } catch (_fallbackErr) {
      return new Response("OG game image error", { status: 500 });
    }
  }
}
