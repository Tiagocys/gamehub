const DEFAULT_LISTING_META_PATH = "/img/meta-listing.png";

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
  const endpoint = `${stripTrailingSlash(supabaseUrl)}/rest/v1/listings?id=eq.${encodedId}&select=id,images&limit=1`;

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
    throw new Error(`Supabase listings query failed (${response.status}): ${payload}`);
  }

  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function resolveListingImage(listing, siteUrl) {
  const images = Array.isArray(listing?.images) ? listing.images : [];
  const first = images.find(Boolean);
  return normalizeImageUrl(first || DEFAULT_LISTING_META_PATH, siteUrl);
}

async function fetchResizedImage(imageUrl) {
  return fetch(imageUrl, {
    cf: {
      image: {
        width: 1200,
        height: 630,
        fit: "contain",
        background: "#ffffff",
        format: "jpeg",
        quality: 85,
      },
    },
  });
}

export async function onRequestGet(context) {
  const listingId = context.params?.id;
  const supabaseUrl = normalizeSupabaseUrl(context.env.SUPABASE_URL, context.env.PROJECT_URL);
  const supabaseAnonKey = cleanEnv(context.env.SUPABASE_ANON_KEY);
  const siteUrl = stripTrailingSlash(cleanEnv(context.env.SITE_URL) || new URL(context.request.url).origin);

  if (!listingId) {
    return new Response("Listing ID ausente.", { status: 400 });
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response("SUPABASE_URL/SUPABASE_ANON_KEY não configuradas no Pages.", { status: 500 });
  }

  try {
    const listing = await fetchListing({ supabaseUrl, supabaseAnonKey, listingId });
    const sourceImageUrl = resolveListingImage(listing, siteUrl);
    const response = await fetchResizedImage(sourceImageUrl);
    if (!response.ok) {
      throw new Error(`Image resize failed (${response.status})`);
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=300");
    headers.set("content-type", headers.get("content-type") || "image/jpeg");
    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error("OG listing image route error:", err);
    const fallbackUrl = normalizeImageUrl(DEFAULT_LISTING_META_PATH, siteUrl);
    const fallback = await fetch(fallbackUrl);
    const headers = new Headers(fallback.headers);
    headers.set("cache-control", "public, max-age=300");
    return new Response(fallback.body, {
      status: fallback.status || 200,
      headers,
    });
  }
}
