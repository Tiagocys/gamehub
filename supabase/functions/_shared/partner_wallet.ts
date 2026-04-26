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
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,last_consumed_at")
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
      last_consumed_at: nowIso,
    })
    .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,last_consumed_at")
    .single();
  if (insertErr) throw insertErr;
  return inserted;
}

export async function getPartnerWalletSummary(supabase: any, userId: string) {
  const wallet = await ensurePartnerWallet(supabase, userId, new Date().toISOString());
  return {
    availableCents: safeSignedInt(wallet?.available_cents),
    totalPurchasedCents: safeInt(wallet?.total_purchased_cents),
    totalConsumedCents: safeInt(wallet?.total_consumed_cents),
    availableAmountBRL: Number((Number(wallet?.available_cents || 0) / 100).toFixed(2)),
  };
}
