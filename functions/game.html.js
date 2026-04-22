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

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const gameId = requestUrl.searchParams.get("id") || "";
  const siteUrl = stripTrailingSlash(context.env.SITE_URL || requestUrl.origin);

  if (!gameId) {
    return context.next();
  }

  const userAgent = context.request.headers.get("user-agent") || "";
  if (looksLikeBot(userAgent)) {
    const ogUrl = new URL(`${siteUrl}/og/game/${encodeURIComponent(gameId)}`);
    const ogResponse = await fetch(new Request(ogUrl.toString(), context.request));
    const headers = new Headers(ogResponse.headers);
    headers.set("cache-control", "no-store");
    headers.set("vary", "user-agent");
    return new Response(ogResponse.body, {
      status: ogResponse.status,
      statusText: ogResponse.statusText,
      headers,
    });
  }

  return context.next();
}
