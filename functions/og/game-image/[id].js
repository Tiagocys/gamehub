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

function resolveGameImage(game, siteUrl) {
  return normalizeImageUrl(game?.banner_url || DEFAULT_GAME_IMAGE_PATH, siteUrl);
}

async function fetchResizedImage(imageUrl) {
  return fetch(imageUrl, {
    cf: {
      image: {
        width: 1200,
        height: 630,
        fit: "pad",
        background: "#ffffff",
        format: "jpeg",
        quality: 88,
      },
    },
  });
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
    const sourceImageUrl = resolveGameImage(game, siteUrl);
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
    console.error("OG game image route error:", err);
    const fallbackImageUrl = normalizeImageUrl(DEFAULT_GAME_IMAGE_PATH, siteUrl);
    const fallback = await fetchResizedImage(fallbackImageUrl);
    const headers = new Headers(fallback.headers);
    headers.set("cache-control", "public, max-age=300");
    headers.set("content-type", headers.get("content-type") || "image/jpeg");
    return new Response(fallback.body, {
      status: fallback.status || 200,
      headers,
    });
  }
}
