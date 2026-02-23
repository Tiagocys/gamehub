import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  action?: "status" | "activate" | "deactivate";
  listingId?: string;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const DAY_SECONDS = 24 * 60 * 60;
const BASE_DAY_PRICE = 10;
const DAY_DISCOUNT = 0;

type WalletRow = {
  user_id: string;
  available_seconds: number;
  total_purchased_seconds: number;
  total_consumed_seconds: number;
  active_listing_count: number;
  last_consumed_at: string;
};

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function secondsToHuman(seconds: number) {
  const total = Math.max(0, safeInt(seconds));
  const days = Math.floor(total / DAY_SECONDS);
  const hours = Math.floor((total % DAY_SECONDS) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return { days, hours, minutes };
}

function perSecondPrice(dayIndex: number) {
  const dayPrice = BASE_DAY_PRICE * ((1 - DAY_DISCOUNT) ** dayIndex);
  return Number((dayPrice / DAY_SECONDS).toFixed(8));
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
  if (isMissingWalletTableError(error)) {
    throw new Error("Tabela de wallet de destaque não encontrada. Aplique as migrations mais recentes.");
  }
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

async function appendWalletEvent(
  supabase: any,
  payload: Record<string, unknown>,
) {
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
  let activeCount = await countActiveHighlights(supabase, userId);
  let available = safeInt(wallet.available_seconds);
  let totalConsumed = safeInt(wallet.total_consumed_seconds);
  const lastConsumedAt = wallet.last_consumed_at ? new Date(wallet.last_consumed_at) : now;
  const elapsedSec = Math.max(
    0,
    Math.floor((now.getTime() - (Number.isNaN(lastConsumedAt.getTime()) ? now.getTime() : lastConsumedAt.getTime())) / 1000),
  );

  let consumedNow = 0;
  let depleted = false;

  if (activeCount > 0) {
    if (available <= 0) {
      await deactivateAllHighlights(supabase, userId);
      activeCount = 0;
      depleted = true;
    } else if (elapsedSec > 0) {
      const requestedConsume = elapsedSec * activeCount;
      if (requestedConsume >= available) {
        consumedNow = available;
        available = 0;
        totalConsumed += consumedNow;
        await deactivateAllHighlights(supabase, userId);
        activeCount = 0;
        depleted = true;
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
      metadata: {
        reason,
        elapsed_seconds: elapsedSec,
        active_listing_count: activeCount,
      },
    });
  }

  if (depleted) {
    await appendWalletEvent(supabase, {
      user_id: userId,
      event_type: "expire",
      seconds_delta: 0,
      balance_after: 0,
      metadata: {
        reason,
        message: "Saldo esgotado durante destaque ativo.",
      },
    });
  }

  const safe = updated as WalletRow;
  return {
    userId: safe.user_id,
    availableSeconds: safeInt(safe.available_seconds),
    totalPurchasedSeconds: safeInt(safe.total_purchased_seconds),
    totalConsumedSeconds: safeInt(safe.total_consumed_seconds),
    activeListingCount: safeInt(safe.active_listing_count),
    lastConsumedAt: safe.last_consumed_at,
    human: secondsToHuman(safeInt(safe.available_seconds)),
    rate: {
      day1PerSecond: perSecondPrice(0),
      day30PerSecond: perSecondPrice(29),
    },
    depleted,
    consumedNow,
  };
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
      const wallet = await syncWallet(supabase, userId, "status");
      return new Response(JSON.stringify({ ok: true, wallet }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (!payload.listingId) {
      return errorResponse("listingId é obrigatório para esta ação", 400);
    }

    let wallet = await syncWallet(supabase, userId, action);

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
        const refreshed = await syncWallet(supabase, userId, "activate-noop");
        return new Response(JSON.stringify({ ok: true, activated: false, wallet: refreshed }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      if (safeInt(wallet.availableSeconds) <= 0) {
        return errorResponse("Saldo de destaque insuficiente. Compre mais saldo para ativar.", 409);
      }

      const nowIso = new Date().toISOString();
      const { error: activateErr } = await supabase
        .from("listings")
        .update({
          highlight_status: "active",
          highlight_started_at: nowIso,
          highlight_expires_at: null,
          highlight_days: 0,
        })
        .eq("id", payload.listingId)
        .eq("user_id", userId);
      if (activateErr) throw activateErr;

      await appendWalletEvent(supabase, {
        user_id: userId,
        event_type: "activate",
        seconds_delta: 0,
        balance_after: safeInt(wallet.availableSeconds),
        listing_id: payload.listingId,
      });
      wallet = await syncWallet(supabase, userId, "activate-post");
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
            highlight_days: 0,
          })
          .eq("id", payload.listingId)
          .eq("user_id", userId);
        if (deactivateErr) throw deactivateErr;

        await appendWalletEvent(supabase, {
          user_id: userId,
          event_type: "deactivate",
          seconds_delta: 0,
          balance_after: safeInt(wallet.availableSeconds),
          listing_id: payload.listingId,
        });
      }
      wallet = await syncWallet(supabase, userId, "deactivate-post");
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
