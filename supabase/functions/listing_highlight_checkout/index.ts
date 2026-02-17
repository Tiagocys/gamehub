import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  listingId?: string;
  days?: number;
  returnBaseUrl?: string;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const BASE_DAY_PRICE = 10;
const DISCOUNT_PER_DAY = 0.1;
const MAX_DAYS = 30;

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function normalizeDays(value: number) {
  const n = Number(value || 1);
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(n)));
}

function calculateTotalCents(days: number) {
  let dayPrice = BASE_DAY_PRICE;
  let total = 0;
  for (let i = 0; i < days; i += 1) {
    const roundedDayPrice = Math.round(dayPrice * 100) / 100;
    total += roundedDayPrice;
    dayPrice *= (1 - DISCOUNT_PER_DAY);
  }
  return Math.round(total * 100);
}

function normalizeBaseUrl(input?: string) {
  if (!input) return null;
  try {
    const u = new URL(input);
    return `${u.origin}`;
  } catch (_err) {
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_SECRET) {
      return errorResponse("Variáveis PROJECT_URL, SERVICE_ROLE_KEY ou STRIPE_SECRET ausentes", 500);
    }

    const payload = (await req.json()) as Payload;
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado", 401);
    if (!payload.listingId) return errorResponse("listingId é obrigatório", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const days = normalizeDays(payload.days || 1);
    const totalCents = calculateTotalCents(days);
    const unitAmount = totalCents;

    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("id,user_id,title,status,highlight_status,highlight_expires_at")
      .eq("id", payload.listingId)
      .eq("user_id", authData.user.id)
      .single();
    if (listingErr || !listing) return errorResponse("Anúncio não encontrado", 404);
    const highlightExpiresAt = listing.highlight_expires_at ? new Date(listing.highlight_expires_at) : null;
    if (listing.highlight_status === "active" && highlightExpiresAt && highlightExpiresAt > new Date()) {
      return errorResponse("Este anúncio já está destacado no momento", 409);
    }

    const baseUrl = normalizeBaseUrl(payload.returnBaseUrl) || new URL(req.url).origin;
    const successUrl = `${baseUrl}/my-listings.html?highlight=success`;
    const cancelUrl = `${baseUrl}/my-listings.html?highlight=cancel`;

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", successUrl);
    body.set("cancel_url", cancelUrl);
    body.set("allow_promotion_codes", "true");
    body.set("payment_method_types[0]", "card");
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "brl");
    body.set("line_items[0][price_data][unit_amount]", String(unitAmount));
    body.set("line_items[0][price_data][product_data][name]", `Destaque de anúncio (${days} dias)`);
    body.set("line_items[0][price_data][product_data][description]", listing.title || "Destaque Gimerr");
    body.set("metadata[listing_id]", listing.id);
    body.set("metadata[user_id]", authData.user.id);
    body.set("metadata[days]", String(days));
    body.set("metadata[total_cents]", String(totalCents));

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const stripeData = await stripeResponse.json();
    if (!stripeResponse.ok) {
      const message = stripeData?.error?.message || "Falha ao criar sessão Stripe";
      return errorResponse(message, 500);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        sessionId: stripeData.id,
        checkoutUrl: stripeData.url,
        days,
        totalCents,
      }),
      { headers: { "content-type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
