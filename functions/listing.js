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
  const listingId = requestUrl.searchParams.get("id") || "";
  const siteUrl = stripTrailingSlash(context.env.SITE_URL || requestUrl.origin);

  if (!listingId) {
    return Response.redirect(`${siteUrl}/listing.html`, 302);
  }

  const userAgent = context.request.headers.get("user-agent") || "";
  if (looksLikeBot(userAgent)) {
    const ogUrl = new URL(`${siteUrl}/og/listing/${encodeURIComponent(listingId)}`);
    return fetch(new Request(ogUrl.toString(), context.request));
  }

  return Response.redirect(`${siteUrl}/listing.html?id=${encodeURIComponent(listingId)}`, 302);
}
