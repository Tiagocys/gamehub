import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  listingId?: string;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET");
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
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGHLIGHT_BASE_DAY_PRICE = 10;
const HIGHLIGHT_DAY_DISCOUNT = 0.1;

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

function normalizeDays(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function calculateSingleDayCents(dayIndex: number) {
  const dayPrice = HIGHLIGHT_BASE_DAY_PRICE * ((1 - HIGHLIGHT_DAY_DISCOUNT) ** dayIndex);
  return Math.round((Math.round(dayPrice * 100) / 100) * 100);
}

function calculateRefundableHighlightDays(
  totalDays: number,
  startedAtRaw: string | null | undefined,
  expiresAtRaw: string | null | undefined,
  now = new Date(),
) {
  if (totalDays <= 0) return 0;
  let startedAt: Date | null = startedAtRaw ? new Date(startedAtRaw) : null;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    if (expiresAt && !Number.isNaN(expiresAt.getTime())) {
      startedAt = new Date(expiresAt.getTime() - (totalDays * DAY_MS));
    }
  }
  if (!startedAt || Number.isNaN(startedAt.getTime())) return 0;
  if (now <= startedAt) return Math.max(totalDays - 1, 0);
  const elapsedDays = Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS);
  return Math.max(totalDays - (elapsedDays + 1), 0);
}

function calculateRefundCents(totalDays: number, refundableDays: number) {
  if (refundableDays <= 0 || totalDays <= 0) return 0;
  const refundedStartDay = totalDays - refundableDays;
  let refundCents = 0;
  for (let dayIndex = refundedStartDay; dayIndex < totalDays; dayIndex += 1) {
    refundCents += calculateSingleDayCents(dayIndex);
  }
  return Math.max(0, refundCents);
}

async function requestStripeRefund(
  paymentIntentId: string,
  amountCents: number,
  listingId: string,
  userId: string,
) {
  if (!STRIPE_SECRET) {
    throw new Error("STRIPE_SECRET ausente para efetuar reembolso");
  }
  if (amountCents <= 0) return null;

  const body = new URLSearchParams();
  body.set("payment_intent", paymentIntentId);
  body.set("amount", String(amountCents));
  body.set("metadata[listing_id]", listingId);
  body.set("metadata[user_id]", userId);
  body.set("metadata[reason]", "listing_deleted_partial_highlight_refund");

  const response = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Falha ao solicitar reembolso (${response.status})`;
    throw new Error(message);
  }
  return data;
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
      .select("id,user_id,images,highlight_status,highlight_days,highlight_started_at,highlight_expires_at,highlight_paid_amount,highlight_payment_intent_id")
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

    let refundableDays = 0;
    let refundedAmount = 0;
    let stripeRefundId: string | null = null;
    const highlightDays = normalizeDays(listing.highlight_days);
    const paidAmountCents = Math.max(0, Math.round(Number(listing.highlight_paid_amount || 0) * 100));
    if (
      listing.highlight_status === "active" &&
      highlightDays > 0 &&
      listing.highlight_payment_intent_id
    ) {
      refundableDays = calculateRefundableHighlightDays(
        highlightDays,
        listing.highlight_started_at,
        listing.highlight_expires_at,
      );
      const calculatedRefundCents = calculateRefundCents(highlightDays, refundableDays);
      const refundCents = Math.min(calculatedRefundCents, paidAmountCents);
      if (refundCents > 0) {
        const stripeRefund = await requestStripeRefund(
          listing.highlight_payment_intent_id,
          refundCents,
          listing.id,
          authData.user.id,
        );
        refundedAmount = Number((refundCents / 100).toFixed(2));
        stripeRefundId = typeof stripeRefund?.id === "string" ? stripeRefund.id : null;
      }
    }

    const { error: delErr } = await supabase
      .from("listings")
      .delete()
      .eq("id", listing.id)
      .eq("user_id", authData.user.id);
    if (delErr) throw delErr;

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
        refundableDays,
        refundedAmount,
        stripeRefundId,
      }),
      { headers: { "content-type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao excluir anúncio", 500);
  }
});
