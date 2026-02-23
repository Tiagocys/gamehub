import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  action?: "onboard" | "status";
  returnBaseUrl?: string;
  userToken?: string;
};

class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function isMissingPartnerColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42703") return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("is_partner") || msg.includes("stripe_connect_");
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

async function stripeRequest(path: string, body?: URLSearchParams) {
  if (!STRIPE_SECRET) {
    throw new AppError("STRIPE_SECRET não configurado", 500);
  }
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body: body.toString() } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Falha na chamada Stripe (${response.status})`;
    throw new AppError(message, 400);
  }
  return data;
}

async function getOrCreateConnectAccount(params: {
  userId: string;
  email?: string | null;
  currentAccountId?: string | null;
}) {
  if (params.currentAccountId) return params.currentAccountId;

  const body = new URLSearchParams();
  body.set("type", "express");
  body.set("country", "BR");
  if (params.email) {
    body.set("email", params.email);
  }
  body.set("capabilities[card_payments][requested]", "true");
  body.set("capabilities[transfers][requested]", "true");
  body.set("metadata[user_id]", params.userId);
  const created = await stripeRequest("/v1/accounts", body);
  return String(created.id || "");
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
    const action = payload.action || "status";

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado", 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);
    const userId = authData.user.id;

    const { data: userRow, error: userErr } = await supabase
      .from("users")
      .select("id,email,is_partner,stripe_connect_account_id,stripe_connect_charges_enabled,stripe_connect_payouts_enabled,stripe_connect_details_submitted,stripe_connect_onboarded_at")
      .eq("id", userId)
      .single();
    if (isMissingPartnerColumnError(userErr)) {
      return errorResponse("Campos de parceiro ausentes no banco. Aplique as migrations mais recentes.", 409);
    }
    if (userErr || !userRow) return errorResponse("Usuário não encontrado", 404);

    if (action === "status") {
      const accountId = userRow.stripe_connect_account_id;
      if (!accountId) {
        return new Response(JSON.stringify({
          ok: true,
          hasAccount: false,
          accountId: null,
          chargesEnabled: false,
          payoutsEnabled: false,
          detailsSubmitted: false,
          onboarded: false,
        }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      const account = await stripeRequest(`/v1/accounts/${encodeURIComponent(accountId)}`);
      const chargesEnabled = !!account?.charges_enabled;
      const payoutsEnabled = !!account?.payouts_enabled;
      const detailsSubmitted = !!account?.details_submitted;
      const onboarded = chargesEnabled && payoutsEnabled;

      const updates: Record<string, unknown> = {
        stripe_connect_charges_enabled: chargesEnabled,
        stripe_connect_payouts_enabled: payoutsEnabled,
        stripe_connect_details_submitted: detailsSubmitted,
      };
      if (onboarded) {
        updates.stripe_connect_onboarded_at = userRow.stripe_connect_onboarded_at || new Date().toISOString();
      }
      if (userRow.is_partner !== true) {
        updates.is_partner = true;
      }

      const { error: updateErr } = await supabase
        .from("users")
        .update(updates)
        .eq("id", userId);
      if (isMissingPartnerColumnError(updateErr)) {
        return errorResponse("Campos de parceiro ausentes no banco. Aplique as migrations mais recentes.", 409);
      }
      if (updateErr) throw updateErr;

      return new Response(JSON.stringify({
        ok: true,
        hasAccount: true,
        accountId,
        chargesEnabled,
        payoutsEnabled,
        detailsSubmitted,
        onboarded,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (action !== "onboard") {
      return errorResponse("Ação inválida", 400);
    }

    const accountId = await getOrCreateConnectAccount({
      userId,
      email: userRow.email || authData.user.email || null,
      currentAccountId: userRow.stripe_connect_account_id,
    });
    if (!accountId) {
      return errorResponse("Não foi possível criar conta Connect", 500);
    }

    const baseUrl = normalizeBaseUrl(payload.returnBaseUrl) || new URL(req.url).origin;
    const refreshUrl = `${baseUrl}/partner.html?connect=retry`;
    const returnUrl = `${baseUrl}/partner.html?connect=return`;

    const body = new URLSearchParams();
    body.set("account", accountId);
    body.set("type", "account_onboarding");
    body.set("refresh_url", refreshUrl);
    body.set("return_url", returnUrl);
    const link = await stripeRequest("/v1/account_links", body);

    const { error: persistErr } = await supabase
      .from("users")
      .update({
        is_partner: true,
        stripe_connect_account_id: accountId,
      })
      .eq("id", userId);
    if (isMissingPartnerColumnError(persistErr)) {
      return errorResponse("Campos de parceiro ausentes no banco. Aplique as migrations mais recentes.", 409);
    }
    if (persistErr) throw persistErr;

    return new Response(JSON.stringify({
      ok: true,
      accountId,
      onboardingUrl: link?.url,
      expiresAt: link?.expires_at || null,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    if (err instanceof AppError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
