import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");

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

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSha256Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return toHex(signature);
}

function parseStripeSignature(header: string) {
  const parts = header.split(",").map((item) => item.trim());
  const values: Record<string, string[]> = {};
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (!values[k]) values[k] = [];
    values[k].push(v);
  }
  return {
    timestamp: values.t?.[0],
    signatures: values.v1 || [],
  };
}

function normalizeDays(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

function normalizeAmountCents(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_WEBHOOK_SECRET) {
      return errorResponse("Variáveis PROJECT_URL, SERVICE_ROLE_KEY ou STRIPE_WEBHOOK_SECRET ausentes", 500);
    }

    const signatureHeader = req.headers.get("stripe-signature") || "";
    if (!signatureHeader) return errorResponse("Stripe-Signature ausente", 401);

    const rawBody = await req.text();
    const parsedSig = parseStripeSignature(signatureHeader);
    if (!parsedSig.timestamp || parsedSig.signatures.length === 0) {
      return errorResponse("Assinatura Stripe inválida", 401);
    }

    const signedPayload = `${parsedSig.timestamp}.${rawBody}`;
    const expectedSignature = await hmacSha256Hex(STRIPE_WEBHOOK_SECRET, signedPayload);
    const valid = parsedSig.signatures.some((sig) => timingSafeEqual(sig, expectedSignature));
    if (!valid) return errorResponse("Assinatura Stripe inválida", 401);

    const event = JSON.parse(rawBody);
    const eventType = event?.type;
    const session = event?.data?.object;

    if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
      const metadata = session?.metadata || {};
      const listingId = metadata.listing_id;
      const userId = metadata.user_id;
      const days = normalizeDays(metadata.days);
      const totalCents = normalizeAmountCents(metadata.total_cents || session?.amount_total || 0);
      const sessionId = session?.id;
      const paymentIntentId = typeof session?.payment_intent === "string" ? session.payment_intent : null;
      const stripeCurrency = typeof session?.currency === "string" ? session.currency.toUpperCase() : "BRL";
      if (!listingId || !userId || !sessionId) {
        return errorResponse("Metadata incompleta no checkout", 400);
      }

      const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: listing, error: listingErr } = await supabase
        .from("listings")
        .select("id,user_id,highlight_expires_at,highlight_checkout_session_id")
        .eq("id", listingId)
        .eq("user_id", userId)
        .single();
      if (listingErr || !listing) {
        return errorResponse("Anúncio não encontrado para aplicar destaque", 404);
      }

      if (listing.highlight_checkout_session_id === sessionId) {
        return new Response(JSON.stringify({ ok: true, duplicate: true }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      const now = new Date();
      const currentExpire = listing.highlight_expires_at ? new Date(listing.highlight_expires_at) : null;
      const baseStart = currentExpire && currentExpire > now ? currentExpire : now;
      const newExpire = new Date(baseStart.getTime() + (days * 24 * 60 * 60 * 1000));

      const { error: updateErr } = await supabase
        .from("listings")
        .update({
          highlight_status: "active",
          highlight_started_at: now.toISOString(),
          highlight_days: days,
          highlight_expires_at: newExpire.toISOString(),
          highlight_checkout_session_id: sessionId,
          highlight_payment_intent_id: paymentIntentId,
          highlight_paid_amount: Number((totalCents / 100).toFixed(2)),
          highlight_currency: stripeCurrency || "BRL",
        })
        .eq("id", listing.id);
      if (updateErr) throw updateErr;
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
