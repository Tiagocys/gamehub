import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { getHighlightPricingForServer, safeInt } from "../_shared/highlight_wallet.ts";
import { getPartnerPayoutSummary } from "../_shared/partner_payout.ts";
import { ensurePartnerWallet, isMissingPartnerWalletTablesError } from "../_shared/partner_wallet.ts";

type Payload = {
  serverId?: string;
  viewerKey?: string;
  pagePath?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const VIEW_WINDOW_SECONDS = 120;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders,
    },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function floorToWindow(date: Date, windowSeconds: number) {
  const windowMs = Math.max(1, windowSeconds) * 1000;
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function normalizeViewerKey(value: unknown) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
  return normalized || "";
}

function isMissingServerFeedMetricsError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  return String(err.message || "").toLowerCase().includes("server_feed_daily_metrics");
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return errorResponse("Método inválido.", 405);
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const payload = (await req.json().catch(() => ({}))) as Payload;
    const serverId = String(payload.serverId || "").trim();
    const viewerKey = normalizeViewerKey(payload.viewerKey);
    const pagePath = String(payload.pagePath || "").trim().slice(0, 200) || null;
    if (!serverId || !viewerKey) {
      return errorResponse("serverId e viewerKey são obrigatórios.", 400);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const chargeWindowKey = floorToWindow(now, VIEW_WINDOW_SECONDS).toISOString();
    const statDate = toIsoDate(now);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: server, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,status,owner_id,feed_highlight_status")
      .eq("id", serverId)
      .maybeSingle();
    if (serverErr) throw serverErr;
    if (!server?.id || String(server.status || "") !== "active" || String(server.feed_highlight_status || "") !== "active") {
      return jsonResponse({ ok: true, ignored: true, reason: "server_not_active" });
    }

    const ownerId = String(server.owner_id || "").trim();
    if (!ownerId) {
      return jsonResponse({ ok: true, ignored: true, reason: "missing_owner" });
    }

    const reservePayload = {
      user_id: ownerId,
      server_id: serverId,
      event_type: "consume",
      amount_delta_cents: 0,
      balance_after_cents: 0,
      currency: "BRL",
      viewer_key: viewerKey,
      charge_window_key: chargeWindowKey,
      metadata: {
        reason: "server_feed_impression",
        stat_date: statDate,
        page_path: pagePath,
      },
    };

    const { data: reservedEvent, error: reserveErr } = await supabase
      .from("partner_wallet_events")
      .insert(reservePayload)
      .select("id")
      .single();
    if (reserveErr) {
      if (reserveErr.code === "23505") {
        return jsonResponse({ ok: true, duplicate: true });
      }
      if (!isMissingPartnerWalletTablesError(reserveErr)) {
        throw reserveErr;
      }
    }
    if (!reservedEvent?.id) {
      return errorResponse("As tabelas da carteira de parceiros não existem. Aplique as migrations mais recentes.", 409);
    }

    const summary = await getPartnerPayoutSummary(supabase, ownerId);
    const combinedAvailableCents = Math.max(0, Math.round(Number(summary?.availableAmount || 0) * 100));
    if (combinedAvailableCents <= 0) {
      await supabase
        .from("servers")
        .update({ feed_highlight_status: "none" })
        .eq("id", serverId)
        .eq("feed_highlight_status", "active");
      await supabase
        .from("partner_wallet_events")
        .delete()
        .eq("id", reservedEvent.id);
      return jsonResponse({ ok: true, paused: true, reason: "insufficient_balance" });
    }

    const pricing = await getHighlightPricingForServer(supabase, serverId, now);
    const { data: metricRow, error: metricErr } = await supabase
      .from("server_feed_daily_metrics")
      .select("server_id,user_id,stat_date,impressions_count,charged_cents,last_impression_at")
      .eq("server_id", serverId)
      .eq("stat_date", statDate)
      .maybeSingle();
    if (isMissingServerFeedMetricsError(metricErr)) {
      throw new Error("A tabela server_feed_daily_metrics não existe. Aplique as migrations mais recentes.");
    }
    if (metricErr) throw metricErr;

    const nextImpressions = safeInt(metricRow?.impressions_count) + 1;
    const currentCharged = safeInt(metricRow?.charged_cents);
    const targetCents = Math.ceil((nextImpressions * pricing.cpmCents) / 1000);
    const additionalCharge = Math.max(0, targetCents - currentCharged);
    const chargeNow = Math.min(combinedAvailableCents, additionalCharge);

    const walletBefore = await ensurePartnerWallet(supabase, ownerId, nowIso);
    const nextWalletAvailableCents = Number(walletBefore.available_cents || 0) - chargeNow;
    const nextTotalConsumedCents = safeInt(walletBefore.total_consumed_cents) + chargeNow;

    if (chargeNow > 0) {
      const { error: walletErr } = await supabase
        .from("partner_wallets")
        .update({
          available_cents: nextWalletAvailableCents,
          total_consumed_cents: nextTotalConsumedCents,
          last_consumed_at: nowIso,
        })
        .eq("user_id", ownerId);
      if (walletErr) throw walletErr;
    }

    const nextMetricPayload = {
      server_id: serverId,
      user_id: ownerId,
      stat_date: statDate,
      impressions_count: nextImpressions,
      charged_cents: currentCharged + chargeNow,
      last_impression_at: nowIso,
    };

    if (metricRow?.server_id) {
      const { error: updateMetricErr } = await supabase
        .from("server_feed_daily_metrics")
        .update(nextMetricPayload)
        .eq("server_id", serverId)
        .eq("stat_date", statDate);
      if (updateMetricErr) throw updateMetricErr;
    } else {
      const { error: insertMetricErr } = await supabase
        .from("server_feed_daily_metrics")
        .insert(nextMetricPayload);
      if (isMissingServerFeedMetricsError(insertMetricErr)) {
        throw new Error("A tabela server_feed_daily_metrics não existe. Aplique as migrations mais recentes.");
      }
      if (insertMetricErr) throw insertMetricErr;
    }

    const { error: finalizeErr } = await supabase
      .from("partner_wallet_events")
      .update({
        amount_delta_cents: -chargeNow,
        balance_after_cents: nextWalletAvailableCents,
        metadata: {
          reason: "server_feed_impression",
          stat_date: statDate,
          page_path: pagePath,
          impressions_count: nextImpressions,
          cpm_cents: pricing.cpmCents,
          cpm_usd: pricing.cpmUsd,
          ads_7d_count: pricing.ads7dCount,
          cpm_tier_label: pricing.tierLabel,
          usd_brl_rate: Number(pricing.usdBrlRate.toFixed(4)),
          rate_date: pricing.rateDate,
        },
      })
      .eq("id", reservedEvent.id);
    if (finalizeErr) throw finalizeErr;

    return jsonResponse({
      ok: true,
      serverId,
      chargedCents: chargeNow,
      impressionsCount: nextImpressions,
      chargeWindowKey,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno.", 500);
  }
});
