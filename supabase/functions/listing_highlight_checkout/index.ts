import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  listingId?: string;
  autoActivate?: boolean;
  amountBRL?: number | string;
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

const MIN_TOPUP_BRL = 5;
const DAY_SECONDS = 24 * 60 * 60;
const PRICE_PER_DAY_CENTS = 500;

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
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

function normalizeAmountBRL(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100) / 100;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  let normalized = raw.replace(/\s+/g, "").replace(/R\$/gi, "");
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }
  normalized = normalized.replace(/[^0-9.]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function amountToSeconds(totalCents: number) {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  return Math.max(1, Math.round((totalCents * DAY_SECONDS) / PRICE_PER_DAY_CENTS));
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

    const amountFromPayload = normalizeAmountBRL(payload.amountBRL);
    const legacyDays = Number(payload.days || 0);
    const fallbackAmount = Number.isFinite(legacyDays) && legacyDays > 0
      ? Math.round(legacyDays * MIN_TOPUP_BRL * 100) / 100
      : null;
    const amountBRL = amountFromPayload ?? fallbackAmount;

    if (!amountBRL || amountBRL < MIN_TOPUP_BRL) {
      return errorResponse("Valor mínimo para depósito: R$ 5,00", 400);
    }

    const totalCents = Math.round(amountBRL * 100);
    const purchasedSeconds = amountToSeconds(totalCents);
    const equivalentDays = Math.max(1, Math.ceil(purchasedSeconds / DAY_SECONDS));

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    let listing: { id: string; user_id: string; title: string | null; status: string } | null = null;
    if (payload.listingId) {
      const { data: listingData, error: listingErr } = await supabase
        .from("listings")
        .select("id,user_id,title,status")
        .eq("id", payload.listingId)
        .eq("user_id", authData.user.id)
        .single();

      if (listingErr || !listingData) return errorResponse("Anúncio não encontrado", 404);
      if (listingData.status !== "active") {
        return errorResponse("Apenas anúncios ativos podem receber destaque.", 409);
      }
      listing = listingData;
    }

    const shouldAutoActivate = Boolean(payload.autoActivate && listing?.id);

    const baseUrl = normalizeBaseUrl(payload.returnBaseUrl) || new URL(req.url).origin;
    const successParams = new URLSearchParams({ highlight: "success" });
    const cancelParams = new URLSearchParams({ highlight: "cancel" });
    if (listing?.id) {
      successParams.set("listing", listing.id);
      cancelParams.set("listing", listing.id);
    }
    if (shouldAutoActivate) {
      successParams.set("activate", "1");
    }
    const successUrl = `${baseUrl}/ad-wallet.html?${successParams.toString()}`;
    const cancelUrl = `${baseUrl}/ad-wallet.html?${cancelParams.toString()}`;

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", successUrl);
    body.set("cancel_url", cancelUrl);
    body.set("allow_promotion_codes", "true");
    body.set("payment_method_types[0]", "card");
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "brl");
    body.set("line_items[0][price_data][unit_amount]", String(totalCents));
    body.set("line_items[0][price_data][product_data][name]", "Saldo da conta de anúncios");
    body.set("line_items[0][price_data][product_data][description]", listing?.title || "Crédito de destaque Gimerr");

    body.set("metadata[user_id]", authData.user.id);
    body.set("metadata[days]", String(equivalentDays));
    body.set("metadata[purchased_seconds]", String(purchasedSeconds));
    body.set("metadata[total_cents]", String(totalCents));
    body.set("metadata[amount_brl]", amountBRL.toFixed(2));
    body.set("metadata[auto_activate]", shouldAutoActivate ? "1" : "0");
    if (listing?.id) {
      body.set("metadata[listing_id]", listing.id);
    }

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
        amountBRL,
        totalCents,
        purchasedSeconds,
        referenceListingId: listing?.id || null,
        autoActivate: shouldAutoActivate,
      }),
      { headers: { "content-type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
