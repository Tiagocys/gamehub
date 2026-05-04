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

export function isMissingPartnerWalletTablesError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const message = String(err.message || "").toLowerCase();
  return message.includes("partner_wallets") || message.includes("partner_wallet_events");
}

export async function ensurePartnerWallet(supabase: any, userId: string, nowIso: string) {
  let { data, error } = await supabase
    .from("partner_wallets")
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,earned_consumed_cents,total_refunded_cents,last_consumed_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (isMissingPartnerWalletTablesError(error)) {
    throw new Error("As tabelas da carteira de parceiros não existem. Aplique as migrations mais recentes.");
  }
  if (error) throw error;
  if (data) return data;

  const { data: inserted, error: insertErr } = await supabase
    .from("partner_wallets")
    .insert({
      user_id: userId,
      available_cents: 0,
      total_purchased_cents: 0,
      total_consumed_cents: 0,
      earned_consumed_cents: 0,
      total_refunded_cents: 0,
      last_consumed_at: nowIso,
    })
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,earned_consumed_cents,total_refunded_cents,last_consumed_at")
    .single();
  if (insertErr) throw insertErr;
  return inserted;
}

export async function getPartnerWalletSummary(supabase: any, userId: string) {
  const wallet = await ensurePartnerWallet(supabase, userId, new Date().toISOString());
  const topupAvailableCents = safeInt(wallet?.available_cents);
  return {
    availableCents: topupAvailableCents,
    topupAvailableCents,
    totalPurchasedCents: safeInt(wallet?.total_purchased_cents),
    totalConsumedCents: safeInt(wallet?.total_consumed_cents),
    earnedConsumedCents: safeInt(wallet?.earned_consumed_cents),
    totalRefundedCents: safeInt(wallet?.total_refunded_cents),
    availableAmountBRL: Number((topupAvailableCents / 100).toFixed(2)),
    refundableTopupAmountBRL: Number((topupAvailableCents / 100).toFixed(2)),
  };
}

export async function consumePartnerBoostBalance(supabase: any, userId: string, chargeCents: number, nowIso: string) {
  const normalizedChargeCents = safeInt(chargeCents, 0);
  const wallet = await ensurePartnerWallet(supabase, userId, nowIso);
  if (normalizedChargeCents <= 0) {
    return {
      nextTopupAvailableCents: safeInt(wallet.available_cents),
      consumedTopupCents: 0,
      consumedEarnedCents: 0,
      wallet,
    };
  }

  const currentTopupAvailableCents = safeInt(wallet.available_cents);
  const consumedTopupCents = Math.min(currentTopupAvailableCents, normalizedChargeCents);
  const consumedEarnedCents = Math.max(0, normalizedChargeCents - consumedTopupCents);
  const nextTopupAvailableCents = currentTopupAvailableCents - consumedTopupCents;
  const nextTotalConsumedCents = safeInt(wallet.total_consumed_cents) + consumedTopupCents;
  const nextEarnedConsumedCents = safeInt(wallet.earned_consumed_cents) + consumedEarnedCents;

  const { error } = await supabase
    .from("partner_wallets")
    .update({
      available_cents: nextTopupAvailableCents,
      total_consumed_cents: nextTotalConsumedCents,
      earned_consumed_cents: nextEarnedConsumedCents,
      last_consumed_at: nowIso,
    })
    .eq("user_id", userId);
  if (error) throw error;

  return {
    nextTopupAvailableCents,
    consumedTopupCents,
    consumedEarnedCents,
    wallet,
  };
}
