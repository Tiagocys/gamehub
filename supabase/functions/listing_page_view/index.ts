import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { getListingViewTotalsByListingIds, LISTING_VIEW_COUNT_WINDOW_SECONDS } from "../_shared/listing_views.ts";

type Payload = {
  listingId?: string;
  viewerKey?: string;
  pagePath?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

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

function normalizeViewerKey(value: unknown) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
  return normalized || "";
}

function floorToWindow(date: Date, windowSeconds: number) {
  const windowMs = Math.max(1, windowSeconds) * 1000;
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function isMissingListingViewMetricsError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  return String(err.message || "").toLowerCase().includes("listing_view_daily_metrics")
    || String(err.message || "").toLowerCase().includes("listing_view_guards");
}

async function getListingTotalViews(supabase: any, listingId: string) {
  const totals = await getListingViewTotalsByListingIds(supabase, [listingId]);
  return safeInt(totals.get(listingId), 0);
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
    const listingId = String(payload.listingId || "").trim();
    const viewerKey = normalizeViewerKey(payload.viewerKey);
    const pagePath = String(payload.pagePath || "").trim().slice(0, 200) || null;
    if (!listingId || !viewerKey) {
      return errorResponse("listingId e viewerKey são obrigatórios.", 400);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const statDate = toIsoDate(now);
    const viewWindowKey = floorToWindow(now, LISTING_VIEW_COUNT_WINDOW_SECONDS).toISOString();

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("id,status,user_id,server_id")
      .eq("id", listingId)
      .maybeSingle();
    if (listingErr) throw listingErr;
    if (!listing?.id || String(listing.status || "") !== "active") {
      return jsonResponse({ ok: true, ignored: true, reason: "listing_not_active" });
    }

    const ownerUserId = String(listing.user_id || "").trim();
    if (!ownerUserId) {
      return jsonResponse({ ok: true, ignored: true, reason: "missing_owner" });
    }

    const { error: guardErr } = await supabase
      .from("listing_view_guards")
      .insert({
        listing_id: listingId,
        viewer_key: viewerKey,
        view_window_key: viewWindowKey,
        page_path: pagePath,
      });
    if (guardErr) {
      if (guardErr.code === "23505") {
        return jsonResponse({
          ok: true,
          duplicate: true,
          totalViews: await getListingTotalViews(supabase, listingId),
        });
      }
      if (isMissingListingViewMetricsError(guardErr)) {
        throw new Error("As tabelas de visualização dos anúncios não existem. Aplique as migrations mais recentes.");
      }
      throw guardErr;
    }

    const { data: metricRow, error: metricErr } = await supabase
      .from("listing_view_daily_metrics")
      .select("listing_id,views_count")
      .eq("listing_id", listingId)
      .eq("stat_date", statDate)
      .maybeSingle();
    if (isMissingListingViewMetricsError(metricErr)) {
      throw new Error("As tabelas de visualização dos anúncios não existem. Aplique as migrations mais recentes.");
    }
    if (metricErr) throw metricErr;

    const nextViewsCount = safeInt(metricRow?.views_count, 0) + 1;
    const nextPayload = {
      listing_id: listingId,
      server_id: listing.server_id || null,
      user_id: ownerUserId,
      stat_date: statDate,
      views_count: nextViewsCount,
      last_view_at: nowIso,
    };

    if (metricRow?.listing_id) {
      const { error: updateMetricErr } = await supabase
        .from("listing_view_daily_metrics")
        .update(nextPayload)
        .eq("listing_id", listingId)
        .eq("stat_date", statDate);
      if (updateMetricErr) throw updateMetricErr;
    } else {
      const { error: insertMetricErr } = await supabase
        .from("listing_view_daily_metrics")
        .insert(nextPayload);
      if (insertMetricErr) throw insertMetricErr;
    }

    return jsonResponse({
      ok: true,
      listingId,
      statDate,
      viewsCount: nextViewsCount,
      totalViews: await getListingTotalViews(supabase, listingId),
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno.", 500);
  }
});
