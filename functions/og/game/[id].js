const DEFAULT_META_PATH = "/img/meta.png";

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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateText(value, max = 180) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1).trimEnd()}…`;
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function isHttpUrl(value) {
  if (!value) return false;
  return /^https?:\/\//i.test(String(value));
}

function looksLikeBot(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua) return false;
  const botHints = [
    "bot",
    "facebookexternalhit",
    "whatsapp",
    "telegrambot",
    "twitterbot",
    "linkedinbot",
    "slackbot",
    "discordbot",
    "skypeuripreview",
    "google-structured-data-testing-tool",
  ];
  return botHints.some((hint) => ua.includes(hint));
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
  const endpoint = `${stripTrailingSlash(supabaseUrl)}/rest/v1/servers?id=eq.${encodedId}&select=id,name,official_site,banner_url,description,status&limit=1`;

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

function renderMetaPage({ title, description, imageUrl, ogUrl, appUrl, siteName = "Gimerr" }) {
  const escTitle = escapeHtml(title);
  const escDescription = escapeHtml(description);
  const escImageUrl = escapeHtml(imageUrl);
  const escOgUrl = escapeHtml(ogUrl);
  const escAppUrl = escapeHtml(appUrl);
  const escSiteName = escapeHtml(siteName);

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escTitle}</title>
  <meta name="description" content="${escDescription}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escSiteName}" />
  <meta property="og:title" content="${escTitle}" />
  <meta property="og:description" content="${escDescription}" />
  <meta property="og:image" content="${escImageUrl}" />
  <meta property="og:image:url" content="${escImageUrl}" />
  <meta property="og:image:secure_url" content="${escImageUrl}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${escTitle}" />
  <meta property="og:url" content="${escOgUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escTitle}" />
  <meta name="twitter:description" content="${escDescription}" />
  <meta name="twitter:image" content="${escImageUrl}" />
  <meta name="twitter:image:src" content="${escImageUrl}" />
  <meta name="twitter:image:alt" content="${escTitle}" />
  <link rel="canonical" href="${escAppUrl}" />
</head>
<body>
  <noscript>
    <p><a href="${escAppUrl}">Abrir game</a></p>
  </noscript>
</body>
</html>`;
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

  const appUrl = `${siteUrl}/game?id=${encodeURIComponent(gameId)}`;
  const ogUrl = `${siteUrl}/og/game/${encodeURIComponent(gameId)}`;
  const userAgent = context.request.headers.get("user-agent") || "";

  if (!looksLikeBot(userAgent)) {
    return Response.redirect(appUrl, 302);
  }

  try {
    const game = await fetchGame({ supabaseUrl, supabaseAnonKey, gameId });

    if (!game) {
      const html = renderMetaPage({
        title: "Game não encontrado | Gimerr",
        description: "Este game foi removido ou não está disponível.",
        imageUrl: normalizeImageUrl(DEFAULT_META_PATH, siteUrl),
        ogUrl,
        appUrl,
      });
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=120",
        },
      });
    }

    const gameTitle = truncateText(game.name || "Game no Gimerr", 110);
    const title = gameTitle;
    const description = truncateText(
      game.description || "Confira este game e seus anúncios no marketplace da comunidade Gimerr.",
      200,
    );
    const imageUrl = `${siteUrl}/og/game-image/${encodeURIComponent(gameId)}`;

    const html = renderMetaPage({
      title,
      description,
      imageUrl,
      ogUrl,
      appUrl,
    });

    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("OG game route error:", err);
    const fallbackHtml = renderMetaPage({
      title: "Gimerr - Marketplace gamer",
      description: "Marketplace da comunidade gamer.",
      imageUrl: normalizeImageUrl(DEFAULT_META_PATH, siteUrl),
      ogUrl,
      appUrl,
    });
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    headers.set("x-og-error", "game-route");
    return new Response(fallbackHtml, {
      status: 200,
      headers,
    });
  }
}
