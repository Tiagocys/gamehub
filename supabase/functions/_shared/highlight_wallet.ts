export const DAY_SECONDS = 24 * 60 * 60;
export const HIGHLIGHT_MIN_DAILY_CENTS = 0;
export const HIGHLIGHT_CPM_USD = 2;
const DEFAULT_USD_BRL_RATE = 5.5;
const FRANKFURTER_API_BASE = "https://api.frankfurter.dev/v1";

let cachedUsdBrlRate: { date: string; value: number } | null = null;

type WalletRow = {
  user_id: string;
  available_cents: number;
  total_purchased_cents: number;
  total_consumed_cents: number;
  active_listing_count: number;
  last_consumed_at: string;
};

type ActiveHighlightRow = {
  id: string;
  user_id: string;
  highlight_started_at: string | null;
  highlight_expires_at?: string | null;
};

type DailyMetricRow = {
  listing_id: string;
  user_id: string;
  stat_date: string;
  impressions_count: number;
  charged_cents: number;
  last_impression_at: string | null;
};

export function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function safeSignedInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function centsToMoney(cents: number) {
  return Number((Math.max(0, cents) / 100).toFixed(2));
}

function getDefaultUsdBrlRate() {
  const parsed = Number(Deno.env.get("USD_BRL_RATE") || DEFAULT_USD_BRL_RATE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_BRL_RATE;
}

async function fetchUsdBrlRateFromFrankfurter() {
  const response = await fetch(`${FRANKFURTER_API_BASE}/latest?base=USD&symbols=BRL`, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Frankfurter rate lookup failed with status ${response.status}`);
  }
  const payload = await response.json();
  const rate = Number(payload?.rates?.BRL);
  const date = String(payload?.date || "").trim();
  if (!Number.isFinite(rate) || rate <= 0 || !date) {
    throw new Error("Frankfurter returned an invalid USD/BRL rate payload");
  }
  cachedUsdBrlRate = { date, value: rate };
  return cachedUsdBrlRate;
}

export async function getHighlightPricing() {
  let usdBrlRate = getDefaultUsdBrlRate();
  let rateDate = null as string | null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cached = cachedUsdBrlRate;
    if (cached?.date === today && Number.isFinite(cached.value) && cached.value > 0) {
      usdBrlRate = cached.value;
      rateDate = cached.date;
    } else {
      const fetched = await fetchUsdBrlRateFromFrankfurter();
      usdBrlRate = fetched.value;
      rateDate = fetched.date;
    }
  } catch (err) {
    console.warn("[highlight-pricing] failed to refresh USD/BRL rate, using fallback", err);
  }

  const cpmCents = Math.max(1, Math.round(HIGHLIGHT_CPM_USD * usdBrlRate * 100));
  return {
    minimumDailyCents: HIGHLIGHT_MIN_DAILY_CENTS,
    cpmCents,
    cpmUsd: HIGHLIGHT_CPM_USD,
    usdBrlRate,
    rateDate,
  };
}

export function isMissingWalletTableError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("wallets")
    || msg.includes("wallet_events")
    || msg.includes("highlight_daily_metrics");
}

function toIsoDate(value: Date | string | null | undefined) {
  const parsed = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function buildDateRange(fromDate: string, toDate: string) {
  const result: string[] = [];
  const cursor = new Date(`${fromDate}T00:00:00.000Z`);
  const end = new Date(`${toDate}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function metricKey(listingId: string, statDate: string) {
  return `${listingId}:${statDate}`;
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

async function deactivateExpiredHighlightsForUser(supabase: any, userId: string, nowIso: string) {
  const { error } = await supabase
    .from("listings")
    .update({
      highlight_status: "none",
    })
    .eq("user_id", userId)
    .eq("highlight_status", "active")
    .not("highlight_expires_at", "is", null)
    .lt("highlight_expires_at", nowIso);
  if (error && !isMissingWalletTableError(error)) throw error;
}

async function fetchActiveHighlights(supabase: any, userId: string, listingIds?: string[]) {
  let query = supabase
    .from("listings")
    .select("id,user_id,highlight_started_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("highlight_status", "active");
  if (Array.isArray(listingIds) && listingIds.length > 0) {
    query = query.in("id", listingIds);
  }
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data as ActiveHighlightRow[] : [];
}

async function deactivateHighlights(supabase: any, userId: string, listingIds?: string[]) {
  if (Array.isArray(listingIds) && listingIds.length === 0) return;
  let query = supabase
    .from("listings")
    .update({
      highlight_status: "none",
      highlight_expires_at: null,
    })
    .eq("user_id", userId)
    .eq("highlight_status", "active");
  if (Array.isArray(listingIds) && listingIds.length > 0) {
    query = query.in("id", listingIds);
  }
  const { error } = await query;
  if (error) throw error;
}

export async function appendWalletEvent(
  supabase: any,
  payload: Record<string, unknown>,
) {
  const { error } = await supabase.from("wallet_events").insert(payload);
  if (isMissingWalletTableError(error)) return;
  if (error) throw error;
}

function normalizeWalletRow(row: WalletRow) {
  const availableCents = safeInt(row.available_cents);
  const totalPurchasedCents = safeInt(row.total_purchased_cents);
  const totalConsumedCents = safeInt(row.total_consumed_cents);
  return {
    availableCents,
    totalPurchasedCents,
    totalConsumedCents,
  };
}

async function persistWallet(
  supabase: any,
  userId: string,
  {
    availableCents,
    totalPurchasedCents,
    totalConsumedCents,
    activeListingCount,
    lastConsumedAt,
  }: {
    availableCents: number;
    totalPurchasedCents: number;
    totalConsumedCents: number;
    activeListingCount: number;
    lastConsumedAt: string;
  },
) {
  const { data, error } = await supabase
    .from("wallets")
    .update({
      available_cents: availableCents,
      total_purchased_cents: totalPurchasedCents,
      total_consumed_cents: totalConsumedCents,
      active_listing_count: activeListingCount,
      last_consumed_at: lastConsumedAt,
    })
    .eq("user_id", userId)
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,active_listing_count,last_consumed_at")
    .single();
  if (error) throw error;
  return data as WalletRow;
}

export async function ensureWallet(supabase: any, userId: string, nowIso: string) {
  let { data, error } = await supabase
    .from("wallets")
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,active_listing_count,last_consumed_at")
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
      available_cents: 0,
      total_purchased_cents: 0,
      total_consumed_cents: 0,
      active_listing_count: activeCount,
      last_consumed_at: nowIso,
    })
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,active_listing_count,last_consumed_at")
    .single();
  if (insertErr) throw insertErr;
  return inserted as WalletRow;
}

async function loadMetrics(
  supabase: any,
  userId: string,
  listingIds: string[],
  fromDate: string,
  toDate: string,
) {
  if (listingIds.length === 0) return new Map<string, DailyMetricRow>();
  const { data, error } = await supabase
    .from("highlight_daily_metrics")
    .select("listing_id,user_id,stat_date,impressions_count,charged_cents,last_impression_at")
    .eq("user_id", userId)
    .in("listing_id", listingIds)
    .gte("stat_date", fromDate)
    .lte("stat_date", toDate);
  if (error) throw error;
  const metrics = new Map<string, DailyMetricRow>();
  (Array.isArray(data) ? data : []).forEach((row: any) => {
    metrics.set(metricKey(String(row.listing_id), String(row.stat_date)), {
      listing_id: String(row.listing_id),
      user_id: String(row.user_id),
      stat_date: String(row.stat_date),
      impressions_count: safeInt(row.impressions_count),
      charged_cents: safeInt(row.charged_cents),
      last_impression_at: row.last_impression_at ? String(row.last_impression_at) : null,
    });
  });
  return metrics;
}

async function upsertMetric(
  supabase: any,
  metric: DailyMetricRow,
) {
  const { error } = await supabase
    .from("highlight_daily_metrics")
    .upsert(metric, { onConflict: "listing_id,stat_date" });
  if (error) throw error;
}

async function upsertDailyConsumeEvent(
  supabase: any,
  {
    userId,
    listingId,
    componentType,
    chargeDate,
    amountDeltaCents,
    balanceAfterCents,
    metadata,
  }: {
    userId: string;
    listingId: string;
    componentType: "impression_cpm" | "daily_minimum_settlement";
    chargeDate: string;
    amountDeltaCents: number;
    balanceAfterCents: number;
    metadata: Record<string, unknown>;
  },
) {
  const aggregateChargeType = "highlight_daily_aggregate";
  const { data: existing, error: existingErr } = await supabase
    .from("wallet_events")
    .select("id,amount_delta_cents,metadata")
    .eq("user_id", userId)
    .eq("listing_id", listingId)
    .eq("event_type", "consume")
    .eq("charge_type", aggregateChargeType)
    .eq("charge_date", chargeDate)
    .maybeSingle();
  if (isMissingWalletTableError(existingErr)) return;
  if (existingErr) throw existingErr;

  const existingMetadata = existing?.metadata && typeof existing.metadata === "object"
    ? existing.metadata as Record<string, unknown>
    : {};
  const componentKey = componentType === "impression_cpm"
    ? "impression_cpm_cents"
    : "daily_minimum_settlement_cents";
  const componentTotal = safeInt(existingMetadata[componentKey]) + Math.abs(amountDeltaCents);
  const mergedMetadata = {
    ...existingMetadata,
    ...metadata,
    charge_type: aggregateChargeType,
    last_component_type: componentType,
    [componentKey]: componentTotal,
  };

  if (!existing) {
    await appendWalletEvent(supabase, {
      user_id: userId,
      event_type: "consume",
      amount_delta_cents: amountDeltaCents,
      balance_after_cents: balanceAfterCents,
      listing_id: listingId,
      charge_type: aggregateChargeType,
      charge_date: chargeDate,
      metadata: mergedMetadata,
    });
    return;
  }

  const { error: updateErr } = await supabase
    .from("wallet_events")
    .update({
      amount_delta_cents: safeSignedInt(existing.amount_delta_cents, 0) + amountDeltaCents,
      balance_after_cents: balanceAfterCents,
      metadata: mergedMetadata,
    })
    .eq("id", existing.id);
  if (isMissingWalletTableError(updateErr)) return;
  if (updateErr) throw updateErr;
}

async function settleCompletedDailyMinimums(
  supabase: any,
  userId: string,
  activeHighlights: ActiveHighlightRow[],
  state: {
    availableCents: number;
    totalPurchasedCents: number;
    totalConsumedCents: number;
  },
  reason: string,
  now: Date,
) {
  if (HIGHLIGHT_MIN_DAILY_CENTS <= 0) {
    return { ...state, deactivatedListingIds: [] as string[] };
  }
  if (activeHighlights.length === 0) {
    return { ...state, deactivatedListingIds: [] as string[] };
  }

  const today = toIsoDate(now);
  const yesterday = toIsoDate(new Date(`${today}T00:00:00.000Z`));
  const yesterdayDate = new Date(`${yesterday}T00:00:00.000Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const lastSettledDate = yesterdayDate.toISOString().slice(0, 10);
  if (lastSettledDate < "2000-01-01") {
    return { ...state, deactivatedListingIds: [] as string[] };
  }
  const earliestStart = activeHighlights.reduce((acc, listing) => {
    const startDate = toIsoDate(listing.highlight_started_at || now);
    return startDate < acc ? startDate : acc;
  }, lastSettledDate);
  const fromDate = earliestStart < lastSettledDate ? earliestStart : lastSettledDate;
  const metrics = await loadMetrics(
    supabase,
    userId,
    activeHighlights.map((item) => item.id),
    fromDate,
    lastSettledDate,
  );

  const toDeactivate = new Set<string>();

  for (const listing of activeHighlights) {
    const startDate = toIsoDate(listing.highlight_started_at || now);
    const endDate = startDate > lastSettledDate ? startDate : lastSettledDate;
    if (startDate > lastSettledDate) continue;
    const dates = buildDateRange(startDate, endDate);
    for (const statDate of dates) {
      const key = metricKey(listing.id, statDate);
      let metric = metrics.get(key);
      if (!metric) {
        metric = {
          listing_id: listing.id,
          user_id: userId,
          stat_date: statDate,
          impressions_count: 0,
          charged_cents: 0,
          last_impression_at: null,
        };
        metrics.set(key, metric);
        await upsertMetric(supabase, metric);
      }

      const minimumDelta = Math.max(0, HIGHLIGHT_MIN_DAILY_CENTS - safeInt(metric.charged_cents));
      if (minimumDelta <= 0) continue;
      if (state.availableCents < minimumDelta) {
        toDeactivate.add(listing.id);
        break;
      }

      state.availableCents -= minimumDelta;
      state.totalConsumedCents += minimumDelta;
      metric.charged_cents += minimumDelta;
      await upsertMetric(supabase, metric);
      await upsertDailyConsumeEvent(supabase, {
        userId,
        listingId: listing.id,
        componentType: "daily_minimum_settlement",
        chargeDate: metric.stat_date,
        amountDeltaCents: -minimumDelta,
        balanceAfterCents: state.availableCents,
        metadata: {
          reason,
          stat_date: metric.stat_date,
          minimum_daily_cents: HIGHLIGHT_MIN_DAILY_CENTS,
        },
      });
    }
  }

  const deactivatedListingIds = Array.from(toDeactivate);
  if (deactivatedListingIds.length > 0) {
    await deactivateHighlights(supabase, userId, deactivatedListingIds);
  }

  return { ...state, deactivatedListingIds };
}

export async function syncHighlightWallet(
  supabase: any,
  userId: string,
  reason: string,
) {
  const pricing = await getHighlightPricing();
  const now = new Date();
  const nowIso = now.toISOString();
  await deactivateExpiredHighlightsForUser(supabase, userId, nowIso);
  const wallet = await ensureWallet(supabase, userId, nowIso);
  const normalized = normalizeWalletRow(wallet);
  const activeHighlights = await fetchActiveHighlights(supabase, userId);

  const state = {
    availableCents: normalized.availableCents,
    totalPurchasedCents: normalized.totalPurchasedCents,
    totalConsumedCents: normalized.totalConsumedCents,
  };

  const charged = await settleCompletedDailyMinimums(supabase, userId, activeHighlights, state, reason, now);
  const activeCount = await countActiveHighlights(supabase, userId);
  const updatedWallet = await persistWallet(supabase, userId, {
    ...charged,
    activeListingCount: activeCount,
    lastConsumedAt: nowIso,
  });
  const safe = normalizeWalletRow(updatedWallet);
  return {
    userId,
    availableCents: safe.availableCents,
    totalPurchasedCents: safe.totalPurchasedCents,
    totalConsumedCents: safe.totalConsumedCents,
    availableAmountBRL: centsToMoney(safe.availableCents),
    totalPurchasedAmountBRL: centsToMoney(safe.totalPurchasedCents),
    totalConsumedAmountBRL: centsToMoney(safe.totalConsumedCents),
    activeListingCount: safeInt(updatedWallet.active_listing_count),
    lastConsumedAt: updatedWallet.last_consumed_at,
    pricing: {
      minimumDailyBRL: centsToMoney(HIGHLIGHT_MIN_DAILY_CENTS),
      cpmBRL: centsToMoney(pricing.cpmCents),
      cpmUSD: pricing.cpmUsd,
      usdBrlRate: Number(pricing.usdBrlRate.toFixed(4)),
      rateDate: pricing.rateDate,
    },
    deactivatedListingIds: charged.deactivatedListingIds,
  };
}

export async function recordHighlightImpressions(
  supabase: any,
  listingIds: string[],
  reason = "index-impression",
) {
  const pricing = await getHighlightPricing();
  const normalizedIds = Array.from(new Set(
    (Array.isArray(listingIds) ? listingIds : []).map((value) => String(value || "").trim()).filter(Boolean),
  ));
  if (normalizedIds.length === 0) {
    return { trackedCount: 0 };
  }

  const { data, error } = await supabase
    .from("listings")
    .select("id,user_id,highlight_started_at,highlight_expires_at")
    .in("id", normalizedIds)
    .eq("status", "active")
    .eq("highlight_status", "active");
  if (error) throw error;

  const nowIso = new Date().toISOString();
  const rows = (Array.isArray(data) ? data : []).filter((row: any) => {
    const expiresAt = row?.highlight_expires_at ? String(row.highlight_expires_at) : "";
    return !expiresAt || expiresAt >= nowIso;
  }) as ActiveHighlightRow[];
  const byUser = new Map<string, string[]>();
  rows.forEach((row) => {
    const existing = byUser.get(row.user_id) || [];
    existing.push(row.id);
    byUser.set(row.user_id, existing);
  });

  let trackedCount = 0;
  for (const [userId, userListingIds] of byUser.entries()) {
    const requestNowIso = new Date().toISOString();
    await deactivateExpiredHighlightsForUser(supabase, userId, requestNowIso);
    const synced = await syncHighlightWallet(supabase, userId, `${reason}-pre`);
    let availableCents = safeInt(synced.availableCents);
    let totalPurchasedCents = safeInt(synced.totalPurchasedCents);
    let totalConsumedCents = safeInt(synced.totalConsumedCents);
    const today = toIsoDate(new Date());
    const metrics = await loadMetrics(supabase, userId, userListingIds, today, today);
    const toDeactivate = new Set<string>();

    for (const listingId of userListingIds) {
      const key = metricKey(listingId, today);
      let metric = metrics.get(key);
      if (!metric) {
        metric = {
          listing_id: listingId,
          user_id: userId,
          stat_date: today,
          impressions_count: 0,
          charged_cents: 0,
          last_impression_at: null,
        };
      }

      const nextImpressions = safeInt(metric.impressions_count) + 1;
      const targetCents = Math.ceil((nextImpressions * pricing.cpmCents) / 1000);
      const additionalCharge = Math.max(0, targetCents - safeInt(metric.charged_cents));
      const chargeNow = Math.min(availableCents, additionalCharge);

      metric.impressions_count = nextImpressions;
      metric.charged_cents = safeInt(metric.charged_cents) + chargeNow;
      metric.last_impression_at = new Date().toISOString();
      await upsertMetric(supabase, metric);

      if (chargeNow > 0) {
        availableCents -= chargeNow;
        totalConsumedCents += chargeNow;
        await upsertDailyConsumeEvent(supabase, {
          userId,
          listingId,
          componentType: "impression_cpm",
          chargeDate: today,
          amountDeltaCents: -chargeNow,
          balanceAfterCents: availableCents,
          metadata: {
            reason,
            stat_date: today,
            impressions_count: nextImpressions,
            cpm_cents: pricing.cpmCents,
            cpm_usd: pricing.cpmUsd,
            usd_brl_rate: Number(pricing.usdBrlRate.toFixed(4)),
            rate_date: pricing.rateDate,
          },
        });
      }

      if (additionalCharge > chargeNow) {
        toDeactivate.add(listingId);
      }

      trackedCount += 1;
    }

    if (toDeactivate.size > 0) {
      await deactivateHighlights(supabase, userId, Array.from(toDeactivate));
    }

    const activeCount = await countActiveHighlights(supabase, userId);
    await persistWallet(supabase, userId, {
      availableCents,
      totalPurchasedCents,
      totalConsumedCents,
      activeListingCount: activeCount,
      lastConsumedAt: new Date().toISOString(),
    });
  }

  return { trackedCount };
}
