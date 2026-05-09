import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { DiscordRateLimitError, leaveDiscordGuild } from "../_shared/discord_bot.ts";
import { deleteLogoFromR2, extractLogoR2Key } from "../_shared/r2_logo.ts";

type Payload = {
  userToken?: string;
  providerToken?: string;
  serverId?: string;
};

type DiscordGuild = {
  id: string;
  owner?: boolean;
  permissions?: string;
  permissions_new?: string;
};

type ListingRow = {
  id: string;
  images: string[] | null;
};

type ReportRow = {
  evidence_images: string[] | null;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_ADMIN_PERMISSION = 0x8n;

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL");
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const textEncoder = new TextEncoder();

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function normalizeSnowflake(value: unknown) {
  const text = String(value || "").trim();
  return /^[0-9]{17,20}$/.test(text) ? text : "";
}

function getGuildPermissions(guild: DiscordGuild) {
  const raw = String(guild.permissions_new || guild.permissions || "0").trim();
  try {
    return BigInt(raw || "0");
  } catch (_err) {
    return 0n;
  }
}

function canManageGuild(guild: DiscordGuild) {
  if (guild.owner) return true;
  return (getGuildPermissions(guild) & DISCORD_ADMIN_PERMISSION) === DISCORD_ADMIN_PERMISSION;
}

function encodeRFC3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(message: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return toHex(digest);
}

async function hmacSha256(key: Uint8Array, data: string) {
  const normalizedKey = Uint8Array.from(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    normalizedKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data));
  return new Uint8Array(signature);
}

async function getSignatureKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = await hmacSha256(textEncoder.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

function buildCanonicalQuery(params: Record<string, string>) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeRFC3986(key)}=${encodeRFC3986(params[key])}`)
    .join("&");
}

function parseR2Key(raw: string): string | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return decodeURIComponent(value.replace(/^\/+/, ""));
  }

  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!path) return null;

    if (R2_PUBLIC_URL) {
      try {
        const publicHost = new URL(R2_PUBLIC_URL).host;
        if (url.host === publicHost) return path;
      } catch (_err) {
        // ignore
      }
    }

    if (R2_BUCKET && path.startsWith(`${R2_BUCKET}/`)) {
      return path.slice(R2_BUCKET.length + 1);
    }

    if (url.host.includes(".r2.cloudflarestorage.com") && R2_BUCKET) {
      const marker = `/${R2_BUCKET}/`;
      const idx = url.pathname.indexOf(marker);
      if (idx >= 0) {
        return decodeURIComponent(url.pathname.slice(idx + marker.length));
      }
    }

    if (url.host.endsWith(".r2.dev")) {
      return path;
    }
  } catch (_err) {
    return null;
  }

  return null;
}

async function buildDeleteUrl(key: string) {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("Variáveis R2 não configuradas");
  }
  const endpoint = R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const canonicalUri = `/${R2_BUCKET}/${key.split("/").map(encodeRFC3986).join("/")}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = "host";

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${R2_ACCESS_KEY_ID}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "120",
    "X-Amz-SignedHeaders": signedHeaders,
  };

  const canonicalQuery = buildCanonicalQuery(queryParams);
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const hashedRequest = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashedRequest,
  ].join("\n");

  const signingKey = await getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBytes.buffer);

  return `${endpointUrl.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function deleteR2Object(key: string) {
  const url = await buildDeleteUrl(key);
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao excluir objeto R2 (${response.status}): ${body}`);
  }
}

async function deleteR2Keys(keys: string[]) {
  const failures: string[] = [];
  for (const key of keys) {
    try {
      await deleteR2Object(key);
    } catch (err) {
      console.error(`Falha ao excluir objeto ${key}`, err);
      failures.push(key);
    }
  }
  return failures;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (!SUPABASE_URL || !SERVICE_KEY) return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);

    const body = (await req.json().catch(() => ({}))) as Payload;
    const token = String(body.userToken || "").trim();
    const providerToken = String(body.providerToken || "").trim();
    const serverId = String(body.serverId || "").trim();
    if (!token || !providerToken || !serverId) return errorResponse("Payload inválido", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const { data: serverRow, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,owner_id,admin_beneficiary_id,status,discord_guild_id,banner_url")
      .eq("id", serverId)
      .neq("status", "deleted")
      .maybeSingle();
    if (serverErr) throw serverErr;
    if (!serverRow?.id) return errorResponse("Servidor não encontrado", 404);

    const currentUserId = String(authData.user.id || "").trim();
    const isAllowedUser = currentUserId
      && (
        currentUserId === String(serverRow.owner_id || "").trim()
        || currentUserId === String(serverRow.admin_beneficiary_id || "").trim()
      );
    const { data: adminRow } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", currentUserId)
      .maybeSingle();
    if (!isAllowedUser && !adminRow?.is_admin) {
      return errorResponse("Acesso restrito ao parceiro responsável por este servidor.", 403);
    }

    const guildId = normalizeSnowflake(serverRow.discord_guild_id);
    if (!guildId) return errorResponse("Este servidor ainda não está vinculado ao Discord.", 409);

    const guildRes = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    if (!guildRes.ok) {
      return errorResponse("Não foi possível validar suas permissões no Discord. Entre novamente com o Discord.", 400);
    }
    const guildRows = (await guildRes.json().catch(() => [])) as DiscordGuild[];
    const guild = Array.isArray(guildRows)
      ? guildRows.find((item) => normalizeSnowflake(item?.id) === guildId)
      : null;
    if (!guild || !canManageGuild(guild)) {
      return errorResponse("Você precisa ser owner ou administrador desse servidor no Discord.", 403);
    }

    const { data: listingRows, error: listingErr } = await supabase
      .from("listings")
      .select("id,images")
      .eq("server_id", serverRow.id);
    if (listingErr) throw listingErr;
    const listings = Array.isArray(listingRows) ? (listingRows as ListingRow[]) : [];
    const listingIds = listings.map((row) => String(row.id || "").trim()).filter(Boolean);

    let reportRows: ReportRow[] = [];
    if (listingIds.length) {
      const { data: reportsData, error: reportsErr } = await supabase
        .from("reports")
        .select("evidence_images")
        .in("listing_id", listingIds);
      if (reportsErr && reportsErr.code !== "42P01") throw reportsErr;
      reportRows = Array.isArray(reportsData) ? (reportsData as ReportRow[]) : [];
    }

    const listingKeys = Array.from(new Set(
      listings
        .flatMap((row) => Array.isArray(row?.images) ? row.images : [])
        .map((item) => parseR2Key(String(item || "")))
        .filter((key): key is string => Boolean(key && key.startsWith("listings/"))),
    ));
    const reportKeys = Array.from(new Set(
      reportRows
        .flatMap((row) => Array.isArray(row?.evidence_images) ? row.evidence_images : [])
        .map((item) => parseR2Key(String(item || "")))
        .filter((key): key is string => Boolean(key && key.startsWith("reports/"))),
    ));
    const serverLogoKey = extractLogoR2Key(String(serverRow.banner_url || "").trim());

    const { error: deleteServerErr } = await supabase
      .from("servers")
      .delete()
      .eq("id", serverRow.id);
    if (deleteServerErr) throw deleteServerErr;

    const deletedListingImageFailures = listingKeys.length ? await deleteR2Keys(listingKeys) : [];
    const deletedReportImageFailures = reportKeys.length ? await deleteR2Keys(reportKeys) : [];
    if (serverLogoKey) {
      try {
        await deleteLogoFromR2(serverLogoKey);
      } catch (err) {
        console.error("Falha ao excluir logo do servidor no R2", err);
      }
    }

    let appRemovalWarning: string | null = null;
    try {
      await leaveDiscordGuild(guildId);
    } catch (err) {
      if (err instanceof DiscordRateLimitError) {
        appRemovalWarning = "O servidor foi removido do Gimerr, mas o Discord limitou temporariamente a saída do App deste servidor.";
      } else {
        console.error("Falha ao remover o App do servidor no Discord", err);
        appRemovalWarning = "O servidor foi removido do Gimerr, mas não foi possível confirmar a saída do App no Discord.";
      }
    }

    return jsonResponse({
      ok: true,
      serverId: serverRow.id,
      guildId,
      deleted: true,
      deletedListings: listingIds.length,
      deletedListingImages: listingKeys.length - deletedListingImageFailures.length,
      deletedReportImages: reportKeys.length - deletedReportImageFailures.length,
      warning: appRemovalWarning,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
