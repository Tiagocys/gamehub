import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import {
  appendWalletEvent,
  centsToMoney,
  safeInt,
  safeSignedInt,
  syncHighlightWallet,
} from "../_shared/highlight_wallet.ts";

type Payload = {
  action?: "status" | "activate" | "deactivate" | "withdraw_request";
  listingId?: string;
  policyAccepted?: boolean;
  activateMode?: "immediate" | "period";
  endAt?: string | null;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const DEFAULT_USD_BRL_RATE = 5.5;

function getUsdBrlRate() {
  const parsed = Number(Deno.env.get("USD_BRL_RATE") || DEFAULT_USD_BRL_RATE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_BRL_RATE;
}

function getMinimumWithdrawCents() {
  return Math.round(2 * getUsdBrlRate() * 100);
}

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

function normalizeHighlightEndAt(raw: string | null | undefined) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
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

    if (action === "status") {
      const wallet = await syncHighlightWallet(supabase, userId, "status");
      return new Response(JSON.stringify({ ok: true, wallet }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (action === "withdraw_request") {
      if (!payload.policyAccepted) {
        return errorResponse("Você precisa aceitar as políticas de anúncio para solicitar saque.", 400);
      }

      const nowIso = new Date().toISOString();
      const wallet = await syncHighlightWallet(supabase, userId, "withdraw-request-pre");
      const availableCents = safeInt(wallet.availableCents);

      if (availableCents <= 0) {
        return errorResponse("Você não possui saldo disponível para saque.", 409);
      }
      if (availableCents < getMinimumWithdrawCents()) {
        return errorResponse("O valor mínimo para solicitar saque é US$ 2,00.", 409);
      }

      await supabase
        .from("listings")
        .update({
          highlight_status: "none",
          highlight_expires_at: null,
        })
        .eq("user_id", userId)
        .eq("highlight_status", "active");

      const requestedRefundBRL = centsToMoney(availableCents);

      const normalizedPurchased = safeSignedInt(wallet.totalPurchasedCents, availableCents);
      const normalizedConsumed = safeSignedInt(wallet.totalConsumedCents, 0);
      const nextTotalConsumedCents = normalizedConsumed + availableCents;

      const { error: resetErr } = await supabase
        .from("wallets")
        .update({
          available_cents: 0,
          total_purchased_cents: normalizedPurchased,
          total_consumed_cents: nextTotalConsumedCents,
          active_listing_count: 0,
          last_consumed_at: nowIso,
        })
        .eq("user_id", userId);
      if (resetErr) throw resetErr;

      await appendWalletEvent(supabase, {
        user_id: userId,
        event_type: "adjust",
        amount_delta_cents: -availableCents,
        balance_after_cents: 0,
        metadata: {
          reason: "withdraw_request",
          status: "pending",
          policy_accepted: true,
          requested_refund_brl: requestedRefundBRL,
          requested_cents: availableCents,
        },
      });

      const refreshed = await syncHighlightWallet(supabase, userId, "withdraw-request-post");
      return new Response(JSON.stringify({
        ok: true,
        withdrawRequested: true,
        requestedRefundBRL,
        wallet: refreshed,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (!payload.listingId) {
      return errorResponse("listingId é obrigatório para esta ação", 400);
    }

    let wallet = await syncHighlightWallet(supabase, userId, action);

    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("id,user_id,status,highlight_status")
      .eq("id", payload.listingId)
      .eq("user_id", userId)
      .single();
    if (listingErr || !listing) return errorResponse("Anúncio não encontrado", 404);

    if (action === "activate") {
      if (listing.status !== "active") {
        return errorResponse("Apenas anúncios ativos podem ser destacados.", 409);
      }
      if (listing.highlight_status === "active") {
        const refreshed = await syncHighlightWallet(supabase, userId, "activate-noop");
        return new Response(JSON.stringify({ ok: true, activated: false, wallet: refreshed }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      const nowIso = new Date().toISOString();
      const activateMode = payload.activateMode === "period" ? "period" : "immediate";
      const normalizedEndAt = activateMode === "period" ? normalizeHighlightEndAt(payload.endAt) : null;
      if (activateMode === "period") {
        if (!normalizedEndAt) {
          return errorResponse("Selecione uma data final válida para o destaque.", 400);
        }
        if (normalizedEndAt <= nowIso) {
          return errorResponse("A data final do destaque precisa ser futura.", 400);
        }
      }
      const { error: activateErr } = await supabase
        .from("listings")
        .update({
          highlight_status: "active",
          highlight_started_at: nowIso,
          highlight_expires_at: normalizedEndAt,
        })
        .eq("id", payload.listingId)
        .eq("user_id", userId);
      if (activateErr) throw activateErr;

      await appendWalletEvent(supabase, {
        user_id: userId,
        event_type: "activate",
        amount_delta_cents: 0,
        balance_after_cents: safeInt(wallet.availableCents),
        listing_id: payload.listingId,
      });
      wallet = await syncHighlightWallet(supabase, userId, "activate-post");
      return new Response(JSON.stringify({ ok: true, activated: true, wallet }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (action === "deactivate") {
      if (listing.highlight_status === "active") {
        const { error: deactivateErr } = await supabase
          .from("listings")
          .update({
            highlight_status: "none",
            highlight_expires_at: null,
          })
          .eq("id", payload.listingId)
          .eq("user_id", userId);
        if (deactivateErr) throw deactivateErr;

        await appendWalletEvent(supabase, {
          user_id: userId,
          event_type: "deactivate",
          amount_delta_cents: 0,
          balance_after_cents: safeInt(wallet.availableCents),
          listing_id: payload.listingId,
        });
      }
      wallet = await syncHighlightWallet(supabase, userId, "deactivate-post");
      return new Response(JSON.stringify({ ok: true, deactivated: true, wallet }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    return errorResponse("Ação inválida", 400);
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
