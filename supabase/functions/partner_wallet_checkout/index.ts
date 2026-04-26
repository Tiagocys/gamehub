import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { enforceUserRateLimit } from "../_shared/rate_limit.ts";

type Payload = {
  amount?: number | string;
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

const MIN_TOPUP_USD = 2;
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

function normalizeMoney(value: unknown): number | null {
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
    if (checkoutCurrency === "usd") return getUsdBrlRateFallback();
    throw new Error("Could not load the selected checkout currency rate.");
  }
  if (checkoutCurrency === "usd") return getUsdBrlRateFallback();
  throw new Error("Could not load the selected checkout currency rate.");
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

    const amount = normalizeMoney(payload.amount);
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    await enforceUserRateLimit(supabase, authData.user.id, "partner_wallet_checkout", {
      maxCount: 8,
      windowSeconds: 15 * 60,
      bucketSeconds: 60,
      message: "Muitas tentativas de checkout. Aguarde alguns minutos e tente novamente.",
    });

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
    const minimumTopupBRL = Math.round(MIN_TOPUP_USD * getUsdBrlRateFallback() * 100) / 100;
    const amountBRL = Number(((amount || 0) * fxRateToBRL).toFixed(2));
    if (!amount || !Number.isFinite(amountBRL) || amountBRL < minimumTopupBRL) {
      return errorResponse("Valor mínimo para depósito: equivalente local a US$ 2,00", 400);
    }
    const totalCents = Math.round(amountBRL * 100);
    const checkoutTotalCents = Math.round(amount * 100);

    const baseUrl = normalizeBaseUrl(payload.returnBaseUrl) || new URL(req.url).origin;
    const successUrl = `${baseUrl}/partner.html?partner_topup=success`;
    const cancelUrl = `${baseUrl}/partner.html?partner_topup=cancel`;

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", successUrl);
    body.set("cancel_url", cancelUrl);
    body.set("allow_promotion_codes", "true");
    body.set("payment_method_types[0]", "card");
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", checkoutCurrency);
    body.set("line_items[0][price_data][unit_amount]", String(checkoutTotalCents));
    body.set("line_items[0][price_data][product_data][name]", "Saldo da conta de parceiro");
    body.set("line_items[0][price_data][product_data][description]", "Crédito para impulsionar servidores no feed do Gimerr");
    body.set("metadata[user_id]", authData.user.id);
    body.set("metadata[wallet_target]", "partner");
    body.set("metadata[checkout_total_cents]", String(checkoutTotalCents));
    body.set("metadata[checkout_currency]", checkoutCurrency.toUpperCase());
    body.set("metadata[checkout_country_code]", resolvedCountryCode);
    body.set("metadata[amount_brl]", amountBRL.toFixed(2));
    body.set("metadata[total_cents]", String(totalCents));
    body.set("metadata[fx_rate]", fxRateToBRL.toFixed(6));

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const stripeData = await stripeResponse.json().catch(() => ({}));
    if (!stripeResponse.ok) {
      const message = stripeData?.error?.message || "Falha ao iniciar checkout";
      return errorResponse(message, 400);
    }

    return new Response(JSON.stringify({
      ok: true,
      checkoutUrl: stripeData.url,
      amountBRL,
      checkoutCurrency: checkoutCurrency.toUpperCase(),
      checkoutTotalCents,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    if (err instanceof Error) {
      return errorResponse(err.message, 400);
    }
    return errorResponse("Erro interno", 500);
  }
});
