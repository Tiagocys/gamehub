import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  listingId?: string;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
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

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
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
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
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
  // 204 is expected; 404 also means "already gone" for our flow.
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao excluir objeto R2 (${response.status}): ${body}`);
  }
}

type WalletRow = {
  user_id: string;
  available_seconds: number;
  total_purchased_seconds: number;
  total_consumed_seconds: number;
  active_listing_count: number;
  last_consumed_at: string;
};

function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function isMissingWalletTableError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("wallets") || msg.includes("wallet_events");
}

async function countActiveHighlights(supabase: any, userId: string) {
  const { count, error } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("highlight_status", "active");
  if (error) throw error;
  return safeInt(count, 0);
}

async function ensureWallet(supabase: any, userId: string, nowIso: string) {
  let { data, error } = await supabase
    .from("wallets")
    .select("user_id,available_seconds,total_purchased_seconds,total_consumed_seconds,active_listing_count,last_consumed_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (isMissingWalletTableError(error)) return null;
  if (error) throw error;
  if (data) return data as WalletRow;

  const activeCount = await countActiveHighlights(supabase, userId);
  const { data: inserted, error: insertErr } = await supabase
    .from("wallets")
    .insert({
      user_id: userId,
      available_seconds: 0,
      total_purchased_seconds: 0,
      total_consumed_seconds: 0,
      active_listing_count: activeCount,
      last_consumed_at: nowIso,
    })
    .select("user_id,available_seconds,total_purchased_seconds,total_consumed_seconds,active_listing_count,last_consumed_at")
    .single();
  if (insertErr) throw insertErr;
  return inserted as WalletRow;
}

async function deactivateAllHighlights(supabase: any, userId: string) {
  const { error } = await supabase
    .from("listings")
    .update({
      highlight_status: "none",
      highlight_expires_at: null,
      highlight_days: 0,
    })
    .eq("user_id", userId)
    .eq("highlight_status", "active");
  if (error) throw error;
}

async function appendWalletEvent(supabase: any, payload: Record<string, unknown>) {
  const { error } = await supabase.from("wallet_events").insert(payload);
  if (isMissingWalletTableError(error)) return;
  if (error) throw error;
}

async function syncWallet(
  supabase: any,
  userId: string,
  reason: string,
) {
  const now = new Date();
  const nowIso = now.toISOString();
  const wallet = await ensureWallet(supabase, userId, nowIso);
  if (!wallet) return null;

  let activeCount = await countActiveHighlights(supabase, userId);
  let available = safeInt(wallet.available_seconds);
  let totalConsumed = safeInt(wallet.total_consumed_seconds);
  const lastConsumedAt = wallet.last_consumed_at ? new Date(wallet.last_consumed_at) : now;
  const elapsedSec = Math.max(
    0,
    Math.floor((now.getTime() - (Number.isNaN(lastConsumedAt.getTime()) ? now.getTime() : lastConsumedAt.getTime())) / 1000),
  );
  let consumedNow = 0;

  if (activeCount > 0) {
    if (available <= 0) {
      await deactivateAllHighlights(supabase, userId);
      activeCount = 0;
    } else if (elapsedSec > 0) {
      const requestedConsume = elapsedSec * activeCount;
      if (requestedConsume >= available) {
        consumedNow = available;
        available = 0;
        totalConsumed += consumedNow;
        await deactivateAllHighlights(supabase, userId);
        activeCount = 0;
      } else {
        consumedNow = requestedConsume;
        available -= consumedNow;
        totalConsumed += consumedNow;
      }
    }
  }

  const { data: updated, error: updateErr } = await supabase
    .from("wallets")
    .update({
      available_seconds: available,
      total_consumed_seconds: totalConsumed,
      active_listing_count: activeCount,
      last_consumed_at: nowIso,
    })
    .eq("user_id", userId)
    .select("user_id,available_seconds,total_purchased_seconds,total_consumed_seconds,active_listing_count,last_consumed_at")
    .single();
  if (updateErr) throw updateErr;

  if (consumedNow > 0) {
    await appendWalletEvent(supabase, {
      user_id: userId,
      event_type: "consume",
      seconds_delta: -consumedNow,
      balance_after: available,
      metadata: { reason, elapsed_seconds: elapsedSec },
    });
  }

  return updated as WalletRow;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const payload = (await req.json()) as Payload;
    const token =
      payload.userToken?.trim() ||
      (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) {
      return errorResponse("Não autorizado", 401);
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    if (!payload.listingId) {
      return errorResponse("listingId é obrigatório", 400);
    }

    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("id,user_id,images,highlight_status")
      .eq("id", payload.listingId)
      .eq("user_id", authData.user.id)
      .single();
    if (listingErr || !listing) {
      return errorResponse("Anúncio não encontrado", 404);
    }

    const imageList = Array.isArray(listing.images) ? listing.images : [];
    const keys = Array.from(new Set(
      imageList
        .map((item) => parseR2Key(String(item)))
        .filter((key): key is string => Boolean(key && key.startsWith(`listings/${authData.user.id}/`))),
    ));
    let reportEvidenceKeys: string[] = [];
    const { data: reportRows, error: reportRowsErr } = await supabase
      .from("reports")
      .select("evidence_images")
      .eq("listing_id", listing.id);
    if (reportRowsErr && reportRowsErr.code !== "42P01") {
      throw reportRowsErr;
    }
    if (Array.isArray(reportRows)) {
      reportEvidenceKeys = Array.from(new Set(
        reportRows
          .flatMap((row) => Array.isArray(row?.evidence_images) ? row.evidence_images : [])
          .map((item) => parseR2Key(String(item)))
          .filter((key): key is string => Boolean(key && key.startsWith("reports/"))),
      ));
    }

    const walletBeforeDelete = await syncWallet(supabase, authData.user.id, "listing-delete-before");

    const { error: delErr } = await supabase
      .from("listings")
      .delete()
      .eq("id", listing.id)
      .eq("user_id", authData.user.id);
    if (delErr) throw delErr;

    if (listing.highlight_status === "active") {
      await appendWalletEvent(supabase, {
        user_id: authData.user.id,
        event_type: "deactivate",
        seconds_delta: 0,
        balance_after: safeInt(walletBeforeDelete?.available_seconds, 0),
        listing_id: listing.id,
        metadata: { reason: "listing_delete" },
      });
    }
    const walletAfterDelete = await syncWallet(supabase, authData.user.id, "listing-delete-after");

    let deletedKeys = 0;
    let failedKeys = 0;
    for (const key of keys) {
      try {
        await deleteR2Object(key);
        deletedKeys += 1;
      } catch (deleteErr) {
        failedKeys += 1;
        console.error(`Falha ao excluir objeto R2 ${key}`, deleteErr);
      }
    }
    let deletedReportEvidenceKeys = 0;
    let failedReportEvidenceKeys = 0;
    for (const key of reportEvidenceKeys) {
      try {
        await deleteR2Object(key);
        deletedReportEvidenceKeys += 1;
      } catch (deleteErr) {
        failedReportEvidenceKeys += 1;
        console.error(`Falha ao excluir anexo de denúncia no R2 ${key}`, deleteErr);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        deletedKeys,
        failedKeys,
        deletedReportEvidenceKeys,
        failedReportEvidenceKeys,
        refundedAmount: 0,
        wallet: walletAfterDelete
          ? {
              availableSeconds: safeInt(walletAfterDelete.available_seconds, 0),
              totalPurchasedSeconds: safeInt(walletAfterDelete.total_purchased_seconds, 0),
              totalConsumedSeconds: safeInt(walletAfterDelete.total_consumed_seconds, 0),
              activeListingCount: safeInt(walletAfterDelete.active_listing_count, 0),
            }
          : null,
      }),
      { headers: { "content-type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao excluir anúncio", 500);
  }
});
