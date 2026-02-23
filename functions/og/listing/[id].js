const DEFAULT_META_PATH = "/img/meta.png";

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

async function fetchListing({ supabaseUrl, supabaseAnonKey, listingId }) {
  const encodedId = encodeURIComponent(listingId);
  const endpoint = `${stripTrailingSlash(supabaseUrl)}/rest/v1/listings?id=eq.${encodedId}&select=id,title,description,images,server_id,status&limit=1`;

  const response = await fetch(endpoint, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Supabase listings query failed (${response.status}): ${payload}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function fetchServerName({ supabaseUrl, supabaseAnonKey, serverId }) {
  if (!serverId) return "";
  const endpoint = `${stripTrailingSlash(supabaseUrl)}/rest/v1/servers?id=eq.${encodeURIComponent(serverId)}&select=name&limit=1`;
  const response = await fetch(endpoint, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) return "";
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0]?.name ? String(rows[0].name) : "";
}

function resolveListingImage(listing, siteUrl) {
  const images = Array.isArray(listing?.images) ? listing.images : [];
  if (images.length === 0) return normalizeImageUrl(DEFAULT_META_PATH, siteUrl);
  const first = images.find(Boolean);
  return normalizeImageUrl(first, siteUrl) || normalizeImageUrl(DEFAULT_META_PATH, siteUrl);
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
  <meta property="og:image:alt" content="${escTitle}" />
  <meta property="og:url" content="${escOgUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escTitle}" />
  <meta name="twitter:description" content="${escDescription}" />
  <meta name="twitter:image" content="${escImageUrl}" />
  <meta name="twitter:image:alt" content="${escTitle}" />
  <link rel="canonical" href="${escAppUrl}" />
</head>
<body>
  <noscript>
    <p><a href="${escAppUrl}">Abrir anúncio</a></p>
  </noscript>
</body>
</html>`;
}

export async function onRequestGet(context) {
  const listingId = context.params?.id;
  const supabaseUrl = context.env.SUPABASE_URL;
  const supabaseAnonKey = context.env.SUPABASE_ANON_KEY;
  const siteUrl = stripTrailingSlash(context.env.SITE_URL || new URL(context.request.url).origin);

  if (!listingId) {
    return new Response("Listing ID ausente.", { status: 400 });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response("SUPABASE_URL/SUPABASE_ANON_KEY não configuradas no Pages.", { status: 500 });
  }

  const appUrl = `${siteUrl}/listing.html?id=${encodeURIComponent(listingId)}`;
  const ogUrl = `${siteUrl}/og/listing/${encodeURIComponent(listingId)}`;
  const userAgent = context.request.headers.get("user-agent") || "";

  // Usuário normal não precisa ficar nesta rota.
  if (!looksLikeBot(userAgent)) {
    return Response.redirect(appUrl, 302);
  }

  try {
    const listing = await fetchListing({ supabaseUrl, supabaseAnonKey, listingId });

    if (!listing) {
      const notFoundTitle = "Anúncio não encontrado | Gimerr";
      const notFoundDescription = "Este anúncio foi removido ou não está disponível.";
      const html = renderMetaPage({
        title: notFoundTitle,
        description: notFoundDescription,
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

    const serverName = await fetchServerName({
      supabaseUrl,
      supabaseAnonKey,
      serverId: listing.server_id,
    });

    const listingTitle = truncateText(listing.title || "Anúncio no Gimerr", 110);
    const title = serverName
      ? `${listingTitle} • ${truncateText(serverName, 40)} | Gimerr`
      : `${listingTitle} | Gimerr`;
    const description = truncateText(
      listing.description || "Confira este anúncio no marketplace da comunidade Gimerr.",
      200,
    );
    const imageUrl = resolveListingImage(listing, siteUrl);

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
    console.error("OG listing route error:", err);
    const fallbackHtml = renderMetaPage({
      title: "Gimerr - Marketplace gamer",
      description: "Marketplace da comunidade gamer.",
      imageUrl: normalizeImageUrl(DEFAULT_META_PATH, siteUrl),
      ogUrl,
      appUrl,
    });
    return new Response(fallbackHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}
