import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { deleteLogoFromR2, extractLogoR2Key, getLogoR2Config } from "../_shared/r2_logo.ts";

type Payload = {
  confirm?: boolean;
  userToken?: string;
};

type PostgrestLikeError = {
  code?: string;
  message?: string;
};

type ProfileRow = { id: string; avatar_url: string | null };
type ListingRow = { id: string; images: string[] | null };
type ServerRow = { id: string; banner_url: string | null };
type ReportRow = { evidence_images: string[] | null };
type TransactionRow = { id: string; buyer_id: string | null; seller_id: string | null };
type ChatRow = { id: string; participant_ids: string[] | null };

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL");
const R2_PROFILE_BUCKET = Deno.env.get("R2_PROFILE_BUCKET") || R2_BUCKET;
const R2_PROFILE_PUBLIC_URL = Deno.env.get("R2_PROFILE_PUBLIC_URL") || R2_PUBLIC_URL;
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT");
const { prefix: R2_LOGO_PREFIX } = getLogoR2Config();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const textEncoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders,
    },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function isMissingRelationOrColumn(error: PostgrestLikeError | null | undefined) {
  const code = String(error?.code || "").trim();
  return code === "42P01" || code === "42703" || code === "PGRST204" || code === "PGRST205";
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

function parseR2Key(
  raw: string,
  options: { publicUrl?: string | null; bucket?: string | null } = {},
): string | null {
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

    if (options.publicUrl) {
      try {
        const publicHost = new URL(options.publicUrl).host;
        if (url.host === publicHost) return path;
      } catch (_err) {
        // ignore malformed configured public URL
      }
    }

    if (options.bucket && path.startsWith(`${options.bucket}/`)) {
      return path.slice(options.bucket.length + 1);
    }

    if (url.host.includes(".r2.cloudflarestorage.com") && options.bucket) {
      const marker = `/${options.bucket}/`;
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

async function buildDeleteUrl(key: string, bucket: string) {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !bucket) {
    throw new Error("Variáveis R2 não configuradas");
  }
  const endpoint = R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const canonicalUri = `/${bucket}/${key.split("/").map(encodeRFC3986).join("/")}`;

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

async function deleteR2Object(key: string, bucket: string) {
  const url = await buildDeleteUrl(key, bucket);
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao excluir objeto R2 (${response.status}): ${body}`);
  }
}

async function deleteR2Keys(keys: string[], bucket: string) {
  const failures: string[] = [];
  for (const key of keys) {
    try {
      await deleteR2Object(key, bucket);
    } catch (err) {
      console.error(`Falha ao excluir objeto ${key}`, err);
      failures.push(key);
    }
  }
  return failures;
}

async function deleteRowsByIds(
  supabase: any,
  table: string,
  ids: string[],
) {
  const normalizedIds = Array.from(new Set(ids.map((id) => String(id || "").trim()).filter(Boolean)));
  if (!normalizedIds.length) return;
  const chunkSize = 100;
  for (let index = 0; index < normalizedIds.length; index += chunkSize) {
    const chunk = normalizedIds.slice(index, index + chunkSize);
    const { error } = await supabase
      .from(table)
      .delete()
      .in("id", chunk);
    if (error) throw error;
  }
}

async function runStep<T>(label: string, action: () => PromiseLike<T> | T): Promise<T> {
  try {
    return await Promise.resolve(action());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err || "Erro desconhecido");
    throw new Error(`${label}: ${detail}`);
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const payload = (await req.json().catch(() => ({}))) as Payload;
    const token =
      String(payload.userToken || "").trim() ||
      (authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "");

    if (!token) return errorResponse("Não autorizado", 401);
    if (payload.confirm !== true) return errorResponse("Confirmação obrigatória", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    const { data: authData, error: authErr } = await runStep("Falha ao validar a sessão", () =>
      supabase.auth.getUser(token)
    );
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    const userId = String(authData.user.id || "").trim();
    if (!userId) return errorResponse("Usuário inválido", 401);

    const { data: profile, error: profileError } = await runStep<{ data: ProfileRow | null; error: PostgrestLikeError | null }>("Falha ao carregar o perfil", () =>
      supabase
        .from("users")
        .select("id,avatar_url")
        .eq("id", userId)
        .maybeSingle()
    );
    if (profileError && profileError.code !== "PGRST116") throw profileError;

    const { data: listings, error: listingsError } = await runStep<{ data: ListingRow[] | null; error: PostgrestLikeError | null }>("Falha ao carregar anúncios do usuário", () =>
      supabase
        .from("listings")
        .select("id,images")
        .eq("user_id", userId)
    );
    if (listingsError) throw listingsError;

    const { data: ownedServers, error: ownedServersError } = await runStep<{ data: ServerRow[] | null; error: PostgrestLikeError | null }>("Falha ao carregar servidores do usuário", () =>
      supabase
        .from("servers")
        .select("id,banner_url")
        .eq("owner_id", userId)
    );
    if (ownedServersError) throw ownedServersError;

    const { data: ownReports, error: ownReportsError } = await runStep<{ data: ReportRow[] | null; error: PostgrestLikeError | null }>("Falha ao carregar denúncias do usuário", () =>
      supabase
        .from("reports")
        .select("evidence_images")
        .eq("reporter_id", userId)
    );
    if (ownReportsError && !isMissingRelationOrColumn(ownReportsError)) throw ownReportsError;

    const listingKeys = Array.from(new Set(
      (listings || [])
        .flatMap((listing: ListingRow) => Array.isArray(listing?.images) ? listing.images : [])
        .map((item: string) => parseR2Key(String(item || ""), { publicUrl: R2_PUBLIC_URL, bucket: R2_BUCKET }))
        .filter((key): key is string => Boolean(key && key.startsWith(`listings/${userId}/`))),
    ));

    const reportKeys = Array.from(new Set(
      (ownReports || [])
        .flatMap((report: ReportRow) => Array.isArray(report?.evidence_images) ? report.evidence_images : [])
        .map((item: string) => parseR2Key(String(item || ""), { publicUrl: R2_PUBLIC_URL, bucket: R2_BUCKET }))
        .filter((key): key is string => Boolean(key && key.startsWith(`reports/${userId}/`))),
    ));

    const avatarKey = parseR2Key(String(profile?.avatar_url || ""), {
      publicUrl: R2_PROFILE_PUBLIC_URL,
      bucket: R2_PROFILE_BUCKET,
    });
    const avatarKeys = avatarKey && avatarKey.startsWith(`avatars/${userId}/`) ? [avatarKey] : [];

    const logoPrefix = `${R2_LOGO_PREFIX}/${userId}/`;
    const logoKeys = Array.from(new Set(
      (ownedServers || [])
        .map((server: ServerRow) => extractLogoR2Key(server?.banner_url))
        .filter((key): key is string => Boolean(key && key.startsWith(logoPrefix))),
    ));

    const r2Failures: string[] = [];
    if (listingKeys.length && R2_BUCKET) {
      r2Failures.push(...await runStep("Falha ao excluir imagens de anúncios no storage", () =>
        deleteR2Keys(listingKeys, R2_BUCKET)
      ));
    }
    if (reportKeys.length && R2_BUCKET) {
      r2Failures.push(...await runStep("Falha ao excluir evidências de denúncia no storage", () =>
        deleteR2Keys(reportKeys, R2_BUCKET)
      ));
    }
    if (avatarKeys.length && R2_PROFILE_BUCKET) {
      r2Failures.push(...await runStep("Falha ao excluir avatar no storage", () =>
        deleteR2Keys(avatarKeys, R2_PROFILE_BUCKET)
      ));
    }
    for (const key of logoKeys) {
      try {
        await deleteLogoFromR2(key);
      } catch (err) {
        console.error(`Falha ao excluir logo ${key}`, err);
        r2Failures.push(key);
      }
    }

    const { data: transactionRows, error: transactionsReadError } = await runStep<{ data: TransactionRow[] | null; error: PostgrestLikeError | null }>("Falha ao carregar transações do usuário", () =>
      supabase
        .from("transactions")
        .select("id,buyer_id,seller_id")
    );
    if (transactionsReadError && !isMissingRelationOrColumn(transactionsReadError)) throw transactionsReadError;
    const transactionIds = (transactionRows || [])
      .filter((row: TransactionRow) => String(row?.buyer_id || "") === userId || String(row?.seller_id || "") === userId)
      .map((row: TransactionRow) => String(row?.id || "").trim())
      .filter(Boolean);
    await runStep("Falha ao excluir transações do usuário", () =>
      deleteRowsByIds(supabase, "transactions", transactionIds)
    );

    const { data: chatRows, error: chatsReadError } = await runStep<{ data: ChatRow[] | null; error: PostgrestLikeError | null }>("Falha ao carregar conversas do usuário", () =>
      supabase
        .from("chats")
        .select("id,participant_ids")
    );
    if (chatsReadError && !isMissingRelationOrColumn(chatsReadError)) throw chatsReadError;
    const chatIds = (chatRows || [])
      .filter((row: ChatRow) => Array.isArray(row?.participant_ids) && row.participant_ids.some((item: unknown) => String(item || "") === userId))
      .map((row: ChatRow) => String(row?.id || "").trim())
      .filter(Boolean);
    await runStep("Falha ao excluir conversas do usuário", () =>
      deleteRowsByIds(supabase, "chats", chatIds)
    );

    const { error: serversDeleteError } = await runStep<{ error: PostgrestLikeError | null }>("Falha ao excluir servidores do usuário", () =>
      supabase
        .from("servers")
        .delete()
        .eq("owner_id", userId)
    );
    if (serversDeleteError) throw serversDeleteError;

    const { error: deleteAuthError } = await runStep("Falha ao excluir a conta de autenticação", () =>
      supabase.auth.admin.deleteUser(userId)
    );
    if (deleteAuthError) throw deleteAuthError;

    return jsonResponse({
      ok: true,
      deletedOwnedServers: Number(ownedServers?.length || 0),
      deletedListings: Number(listings?.length || 0),
      storageWarnings: r2Failures,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Falha ao excluir conta", 500);
  }
});
