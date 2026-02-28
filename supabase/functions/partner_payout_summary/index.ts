import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

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

function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function toDate(value: unknown) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMissingPartnerPayoutTableError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const message = String(err.message || "").toLowerCase();
  return message.includes("partner_payout_events");
}

function isMissingWalletTablesError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const message = String(err.message || "").toLowerCase();
  return message.includes("wallets") || message.includes("wallet_events");
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

type PayerConsumption = {
  consumedSeconds: number;
  ratiosByCheckout: Map<string, number>;
};

async function computePayerConsumption(supabase: any, payerUserId: string): Promise<PayerConsumption> {
  const { data: walletRows, error: walletErr } = await supabase
    .from("wallets")
    .select("available_seconds,total_consumed_seconds,last_consumed_at")
    .eq("user_id", payerUserId)
    .limit(1);
  if (isMissingWalletTablesError(walletErr)) {
    return { consumedSeconds: 0, ratiosByCheckout: new Map() };
  }
  if (walletErr) throw walletErr;

  const wallet = Array.isArray(walletRows) && walletRows.length > 0 ? walletRows[0] : null;
  if (!wallet) {
    return { consumedSeconds: 0, ratiosByCheckout: new Map() };
  }

  const now = new Date();
  const lastConsumedAt = toDate(wallet.last_consumed_at) || now;
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastConsumedAt.getTime()) / 1000));
  const activeCount = await countActiveHighlights(supabase, payerUserId);
  const availableSeconds = safeInt(wallet.available_seconds);
  const consumedAlready = safeInt(wallet.total_consumed_seconds);

  let consumedNow = 0;
  if (activeCount > 0 && elapsedSeconds > 0 && availableSeconds > 0) {
    consumedNow = Math.min(availableSeconds, elapsedSeconds * activeCount);
  }

  const consumedSeconds = consumedAlready + consumedNow;

  const { data: topupEvents, error: eventsErr } = await supabase
    .from("wallet_events")
    .select("checkout_session_id,seconds_delta,created_at")
    .eq("user_id", payerUserId)
    .eq("event_type", "topup")
    .not("checkout_session_id", "is", null)
    .order("created_at", { ascending: true });
  if (isMissingWalletTablesError(eventsErr)) {
    return { consumedSeconds, ratiosByCheckout: new Map() };
  }
  if (eventsErr) throw eventsErr;

  const orderedSessions: string[] = [];
  const secondsBySession = new Map<string, number>();
  (topupEvents || []).forEach((event: any) => {
    const checkout = String(event?.checkout_session_id || "").trim();
    if (!checkout) return;
    const seconds = safeInt(event?.seconds_delta, 0);
    if (seconds <= 0) return;
    if (!secondsBySession.has(checkout)) {
      orderedSessions.push(checkout);
      secondsBySession.set(checkout, seconds);
      return;
    }
    secondsBySession.set(checkout, safeInt(secondsBySession.get(checkout), 0) + seconds);
  });

  let remaining = consumedSeconds;
  const ratiosByCheckout = new Map<string, number>();
  orderedSessions.forEach((checkout) => {
    const totalSeconds = safeInt(secondsBySession.get(checkout), 0);
    if (totalSeconds <= 0) {
      ratiosByCheckout.set(checkout, 0);
      return;
    }
    const consumed = Math.min(remaining, totalSeconds);
    const ratio = Math.max(0, Math.min(1, consumed / totalSeconds));
    ratiosByCheckout.set(checkout, ratio);
    remaining = Math.max(0, remaining - consumed);
  });

  return { consumedSeconds, ratiosByCheckout };
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "";
    if (!token) return errorResponse("Não autorizado", 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);
    const userId = authData.user.id;

    const { data: payoutRows, error: payoutErr } = await supabase
      .from("partner_payout_events")
      .select("id,payer_user_id,checkout_session_id,expected_net_amount,refunded_net_amount,payout_status,currency")
      .eq("owner_user_id", userId)
      .neq("payout_status", "paid");

    if (isMissingPartnerPayoutTableError(payoutErr)) {
      return new Response(JSON.stringify({
        ok: true,
        summary: {
          unsupported: true,
        },
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }
    if (payoutErr) throw payoutErr;

    const rows = Array.isArray(payoutRows) ? payoutRows : [];
    if (rows.length === 0) {
      return new Response(JSON.stringify({
        ok: true,
        summary: {
          unsupported: false,
          totalExpected: 0,
          availableAmount: 0,
          pendingAmount: 0,
          count: 0,
          method: "wallet-consume-fifo-v1",
        },
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const payerIds = Array.from(new Set(
      rows.map((row: any) => String(row?.payer_user_id || "").trim()).filter(Boolean),
    ));

    const payerConsumptionMap = new Map<string, PayerConsumption>();
    await Promise.all(payerIds.map(async (payerId) => {
      const consumption = await computePayerConsumption(supabase, payerId);
      payerConsumptionMap.set(payerId, consumption);
    }));

    let totalExpectedCents = 0;
    let availableCents = 0;
    let pendingCents = 0;
    let consideredCount = 0;

    rows.forEach((row: any) => {
      const status = String(row?.payout_status || "").toLowerCase();
      if (status === "refunded") return;

      const expectedCents = Math.max(0, Math.round(Number(row?.expected_net_amount || 0) * 100));
      const refundedCents = Math.max(0, Math.round(Number(row?.refunded_net_amount || 0) * 100));
      const effectiveCents = Math.max(0, expectedCents - refundedCents);
      if (effectiveCents <= 0) return;

      const payerId = String(row?.payer_user_id || "").trim();
      const checkoutSessionId = String(row?.checkout_session_id || "").trim();
      const ratio = payerId && checkoutSessionId
        ? (payerConsumptionMap.get(payerId)?.ratiosByCheckout.get(checkoutSessionId) ?? 0)
        : 0;
      const clampedRatio = Math.max(0, Math.min(1, ratio));

      const rowAvailableCents = Math.min(
        effectiveCents,
        Math.round(effectiveCents * clampedRatio),
      );
      const rowPendingCents = Math.max(0, effectiveCents - rowAvailableCents);

      totalExpectedCents += effectiveCents;
      availableCents += rowAvailableCents;
      pendingCents += rowPendingCents;
      consideredCount += 1;
    });

    return new Response(JSON.stringify({
      ok: true,
      summary: {
        unsupported: false,
        totalExpected: Number((totalExpectedCents / 100).toFixed(2)),
        availableAmount: Number((availableCents / 100).toFixed(2)),
        pendingAmount: Number((pendingCents / 100).toFixed(2)),
        count: consideredCount,
        method: "wallet-consume-fifo-v1",
      },
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});

