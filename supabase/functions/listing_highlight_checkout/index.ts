import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  listingId?: string;
  autoActivate?: boolean;
  amount?: number | string;
  amountBRL?: number | string;
  currency?: string;
  countryCode?: string;
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
const PRICE_PER_DAY_CENTS = 600;
const DEFAULT_USD_BRL_RATE = 5.5;
const CHECKOUT_RATE_API = "https://api.frankfurter.dev/v1/latest";
const SUPPORTED_CHECKOUT_CURRENCIES = new Set([
  "brl",
  "usd",
  "eur",
  "gbp",
  "cad",
  "aud",
  "nzd",
  "mxn",
  "chf",
  "sek",
  "nok",
  "dkk",
  "pln",
]);
const SUPPORTED_CHECKOUT_COUNTRIES = [
  { code: "BR", currency: "brl" },
  { code: "US", currency: "usd" },
  { code: "CA", currency: "cad" },
  { code: "GB", currency: "gbp" },
  { code: "AU", currency: "aud" },
  { code: "NZ", currency: "nzd" },
  { code: "MX", currency: "mxn" },
  { code: "CH", currency: "chf" },
  { code: "SE", currency: "sek" },
  { code: "NO", currency: "nok" },
  { code: "DK", currency: "dkk" },
  { code: "PL", currency: "pln" },
  { code: "DE", currency: "eur" },
  { code: "FR", currency: "eur" },
  { code: "ES", currency: "eur" },
  { code: "IT", currency: "eur" },
  { code: "PT", currency: "eur" },
  { code: "NL", currency: "eur" },
  { code: "BE", currency: "eur" },
  { code: "IE", currency: "eur" },
  { code: "AT", currency: "eur" },
  { code: "FI", currency: "eur" },
  { code: "GR", currency: "eur" },
  { code: "OTHER", currency: "usd" },
] as const;

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

function normalizeCheckoutCurrency(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return SUPPORTED_CHECKOUT_CURRENCIES.has(normalized) ? normalized : "usd";
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function inferCountryCodeFromPhone(phone: unknown) {
  const normalized = normalizePhone(phone);
  const prefixes = [
    ["55", "BR"],
    ["41", "CH"],
    ["52", "MX"],
    ["44", "GB"],
    ["61", "AU"],
    ["64", "NZ"],
    ["46", "SE"],
    ["47", "NO"],
    ["45", "DK"],
    ["48", "PL"],
    ["49", "DE"],
    ["33", "FR"],
    ["34", "ES"],
    ["39", "IT"],
    ["351", "PT"],
    ["31", "NL"],
    ["32", "BE"],
    ["353", "IE"],
    ["43", "AT"],
    ["358", "FI"],
    ["30", "GR"],
    ["1", "US"],
  ] as const;
  for (const [prefix, countryCode] of prefixes) {
    if (normalized.startsWith(prefix)) return countryCode;
  }
  return "OTHER";
}

function getCheckoutCountryConfig(countryCode: unknown) {
  const normalized = String(countryCode || "").trim().toUpperCase();
  return SUPPORTED_CHECKOUT_COUNTRIES.find((item) => item.code === normalized) || null;
}

function getUsdBrlRateFallback() {
  const parsed = Number(Deno.env.get("USD_BRL_RATE") || DEFAULT_USD_BRL_RATE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_BRL_RATE;
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

async function getCurrencyRateToBRL(checkoutCurrency: string) {
  if (checkoutCurrency === "brl") return 1;
  try {
    const response = await fetch(`${CHECKOUT_RATE_API}?base=${checkoutCurrency.toUpperCase()}&symbols=BRL`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || "Could not load checkout exchange rate.");
    }
    const parsed = Number(payload?.rates?.BRL);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  } catch (_err) {
    if (checkoutCurrency === "usd") {
      return getUsdBrlRateFallback();
    }
    throw new Error("Could not load the selected checkout currency rate.");
  }
  if (checkoutCurrency === "usd") {
    return getUsdBrlRateFallback();
  }
  throw new Error("Could not load the selected checkout currency rate.");
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

    const amountFromCurrencyPayload = normalizeAmountBRL(payload.amount);
    const amountFromPayload = normalizeAmountBRL(payload.amountBRL);
    const legacyDays = Number(payload.days || 0);
    const fallbackAmount = Number.isFinite(legacyDays) && legacyDays > 0
      ? Math.round(legacyDays * MIN_TOPUP_BRL * 100) / 100
      : null;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const { data: profile, error: profileErr } = await supabase
      .from("users")
      .select("phone,phone_verified,country_code")
      .eq("id", authData.user.id)
      .single();
    if (profileErr || !profile) return errorResponse("Perfil não encontrado", 404);
    if (!profile.phone_verified) {
      return errorResponse("Verifique seu telefone antes de adicionar saldo.", 403);
    }

    const resolvedCountryCode = getCheckoutCountryConfig(profile.country_code)?.code
      || getCheckoutCountryConfig(inferCountryCodeFromPhone(profile.phone))?.code
      || "OTHER";
    const checkoutCurrency = normalizeCheckoutCurrency(getCheckoutCountryConfig(resolvedCountryCode)?.currency || "usd");
    const fxRateToBRL = await getCurrencyRateToBRL(checkoutCurrency);
    const amountBRL = amountFromCurrencyPayload != null
      ? Number((amountFromCurrencyPayload * fxRateToBRL).toFixed(2))
      : (amountFromPayload ?? fallbackAmount);

    if (!amountBRL || amountBRL < MIN_TOPUP_BRL) {
      return errorResponse("Valor mínimo para depósito: R$ 5,00", 400);
    }

    const totalCents = Math.round(amountBRL * 100);
    const purchasedSeconds = amountToSeconds(totalCents);
    const equivalentDays = Math.max(1, Math.ceil(purchasedSeconds / DAY_SECONDS));
    const checkoutAmount = amountFromCurrencyPayload != null
      ? amountFromCurrencyPayload
      : Number((amountBRL / fxRateToBRL).toFixed(2));
    const checkoutTotalCents = Math.round(checkoutAmount * 100);

    if (!Number.isFinite(checkoutTotalCents) || checkoutTotalCents <= 0) {
      return errorResponse("Valor inválido para checkout.", 400);
    }

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
    body.set("line_items[0][price_data][currency]", checkoutCurrency);
    body.set("line_items[0][price_data][unit_amount]", String(checkoutTotalCents));
    body.set("line_items[0][price_data][product_data][name]", "Saldo da conta de anúncios");
    body.set("line_items[0][price_data][product_data][description]", listing?.title || "Crédito de destaque Gimerr");

    body.set("metadata[user_id]", authData.user.id);
    body.set("metadata[days]", String(equivalentDays));
    body.set("metadata[purchased_seconds]", String(purchasedSeconds));
    body.set("metadata[total_cents]", String(totalCents));
    body.set("metadata[checkout_total_cents]", String(checkoutTotalCents));
    body.set("metadata[checkout_currency]", checkoutCurrency.toUpperCase());
    body.set("metadata[checkout_country_code]", resolvedCountryCode);
    body.set("metadata[amount_brl]", amountBRL.toFixed(2));
    body.set("metadata[fx_rate]", fxRateToBRL.toFixed(6));
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
        checkoutCurrency: checkoutCurrency.toUpperCase(),
        checkoutTotalCents,
        fxRateToBRL,
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
