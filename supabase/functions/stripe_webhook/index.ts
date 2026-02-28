import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const NET_ESTIMATE_RATIO = 0.921;
const PARTNER_SHARE_RATIO = 0.5;
const ADMIN_SHARE_RATIO = 0.25;
const DAY_SECONDS = 24 * 60 * 60;
const PRICE_PER_DAY_CENTS = 500;

const textEncoder = new TextEncoder();

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSha256Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return toHex(signature);
}

function parseStripeSignature(header: string) {
  const parts = header.split(",").map((item) => item.trim());
  const values: Record<string, string[]> = {};
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (!values[k]) values[k] = [];
    values[k].push(v);
  }
  return {
    timestamp: values.t?.[0],
    signatures: values.v1 || [],
  };
}

function normalizeDays(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
}

function normalizeAmountCents(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed);
}

function normalizeMoney(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Number(parsed.toFixed(2));
}

function centsToMoney(cents: number) {
  return Number((Math.max(0, cents) / 100).toFixed(2));
}

function isMissingPartnerPayoutTableError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("partner_payout_events");
}

function isMissingPayoutRoleColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("payout_role");
}

function isMissingShareRatioColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("share_ratio");
}

function isMissingAdminBeneficiaryColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("admin_beneficiary_id");
}

function isMissingWalletTableError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  if (err.code === "42P01" || err.code === "42703") return true;
  const msg = String(err.message || "").toLowerCase();
  return msg.includes("wallets") || msg.includes("wallet_events");
}

type WalletRow = {
  user_id: string;
  available_seconds: number;
  total_purchased_seconds: number;
  total_consumed_seconds: number;
  active_listing_count: number;
  last_consumed_at: string;
};

function safeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
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

  if (activeCount > 0) {
    if (available <= 0) {
      await deactivateAllHighlights(supabase, userId);
      activeCount = 0;
    } else if (elapsedSec > 0) {
      const requestedConsume = elapsedSec * activeCount;
      if (requestedConsume >= available) {
        consumedNow = available;
        available = 0;
        totalConsumed += consumedNow;
        await deactivateAllHighlights(supabase, userId);
        activeCount = 0;
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
      },
    });
  }

  return updated as WalletRow;
}

type StripeNetDetails = {
  netCents: number | null;
  feeCents: number | null;
  chargeId: string | null;
  balanceTransactionId: string | null;
};

async function fetchStripeNetDetails(paymentIntentId: string | null): Promise<StripeNetDetails> {
  if (!paymentIntentId || !STRIPE_SECRET) {
    return {
      netCents: null,
      feeCents: null,
      chargeId: null,
      balanceTransactionId: null,
    };
  }

  try {
    const params = new URLSearchParams();
    params.set("expand[]", "latest_charge.balance_transaction");
    const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET}`,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Falha ao consultar payment_intent ${paymentIntentId}`;
      console.warn(message);
      return {
        netCents: null,
        feeCents: null,
        chargeId: null,
        balanceTransactionId: null,
      };
    }

    const charge = payload?.latest_charge;
    const chargeId = typeof charge?.id === "string" ? charge.id : null;
    const balanceTx = charge?.balance_transaction;
    const balanceTransactionId = typeof balanceTx?.id === "string" ? balanceTx.id : null;
    const netCents = typeof balanceTx?.net === "number" ? Math.max(0, Math.round(balanceTx.net)) : null;
    const feeCents = typeof balanceTx?.fee === "number" ? Math.max(0, Math.round(balanceTx.fee)) : null;

    return {
      netCents,
      feeCents,
      chargeId,
      balanceTransactionId,
    };
  } catch (err) {
    console.warn("Erro ao consultar net da Stripe", err);
    return {
      netCents: null,
      feeCents: null,
      chargeId: null,
      balanceTransactionId: null,
    };
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_WEBHOOK_SECRET) {
      return errorResponse("Variáveis PROJECT_URL, SERVICE_ROLE_KEY ou STRIPE_WEBHOOK_SECRET ausentes", 500);
    }

    const signatureHeader = req.headers.get("stripe-signature") || "";
    if (!signatureHeader) return errorResponse("Stripe-Signature ausente", 401);

    const rawBody = await req.text();
    const parsedSig = parseStripeSignature(signatureHeader);
    if (!parsedSig.timestamp || parsedSig.signatures.length === 0) {
      return errorResponse("Assinatura Stripe inválida", 401);
    }

    const signedPayload = `${parsedSig.timestamp}.${rawBody}`;
    const expectedSignature = await hmacSha256Hex(STRIPE_WEBHOOK_SECRET, signedPayload);
    const valid = parsedSig.signatures.some((sig) => timingSafeEqual(sig, expectedSignature));
    if (!valid) return errorResponse("Assinatura Stripe inválida", 401);

    const event = JSON.parse(rawBody);
    const eventType = event?.type;
    const session = event?.data?.object;

    if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
      const metadata = session?.metadata || {};
      const listingId = metadata.listing_id;
      const userId = metadata.user_id;
      const totalCents = normalizeAmountCents(metadata.total_cents || session?.amount_total || 0);
      const metadataDays = normalizeDays(metadata.days);
      const fallbackSecondsByAmount = Math.max(1, Math.round((totalCents * DAY_SECONDS) / PRICE_PER_DAY_CENTS));
      const fallbackSecondsByDays = metadataDays * DAY_SECONDS;
      const purchasedSeconds = safeInt(
        metadata.purchased_seconds,
        fallbackSecondsByAmount > 0 ? fallbackSecondsByAmount : fallbackSecondsByDays,
      );
      const daysEquivalent = Math.max(1, Math.ceil(purchasedSeconds / DAY_SECONDS));
      const sessionId = session?.id;
      const paymentIntentId = typeof session?.payment_intent === "string" ? session.payment_intent : null;
      const stripeCurrency = typeof session?.currency === "string" ? session.currency.toUpperCase() : "BRL";
      if (!listingId || !userId || !sessionId) {
        return errorResponse("Metadata incompleta no checkout", 400);
      }

      const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: listing, error: listingErr } = await supabase
        .from("listings")
        .select("id,user_id,server_id,status,highlight_status")
        .eq("id", listingId)
        .eq("user_id", userId)
        .single();
      if (listingErr || !listing) {
        return errorResponse("Anúncio não encontrado para aplicar destaque", 404);
      }

      const nowIso = new Date().toISOString();
      const baseEventPayload = {
        user_id: userId,
        event_type: "topup",
        seconds_delta: purchasedSeconds,
        balance_after: 0,
        listing_id: listing.id,
        checkout_session_id: sessionId,
        payment_intent_id: paymentIntentId,
        amount_paid: Number((totalCents / 100).toFixed(2)),
        currency: stripeCurrency || "BRL",
        metadata: {
          days: daysEquivalent,
          purchased_seconds: purchasedSeconds,
          source: "stripe_webhook",
        },
      };
      let topupReserved = false;
      let topupApplied = false;
      try {
        const { error: reserveTopupErr } = await supabase
          .from("wallet_events")
          .insert(baseEventPayload);
        if (reserveTopupErr) {
          if (reserveTopupErr.code === "23505") {
            return new Response(JSON.stringify({ ok: true, duplicate: true }), {
              headers: { "content-type": "application/json", ...corsHeaders },
            });
          }
          if (!isMissingWalletTableError(reserveTopupErr)) {
            throw reserveTopupErr;
          }
        } else {
          topupReserved = true;
        }

        const beforeTopup = await syncWallet(supabase, userId, "stripe-webhook-before-topup");
        const { data: toppedWallet, error: topupErr } = await supabase
          .from("wallets")
          .update({
            available_seconds: safeInt(beforeTopup.available_seconds) + purchasedSeconds,
            total_purchased_seconds: safeInt(beforeTopup.total_purchased_seconds) + purchasedSeconds,
            last_consumed_at: nowIso,
          })
          .eq("user_id", userId)
          .select("user_id,available_seconds,total_purchased_seconds,total_consumed_seconds,active_listing_count,last_consumed_at")
          .single();
        if (topupErr) throw topupErr;
        topupApplied = true;

        const { error: confirmEventErr } = await supabase
          .from("wallet_events")
          .update({ balance_after: safeInt(toppedWallet?.available_seconds) })
          .eq("checkout_session_id", sessionId)
          .eq("event_type", "topup");
        if (confirmEventErr && !isMissingWalletTableError(confirmEventErr)) throw confirmEventErr;
      } catch (topupFlowErr) {
        if (topupReserved && !topupApplied) {
          await supabase
            .from("wallet_events")
            .delete()
            .eq("checkout_session_id", sessionId)
            .eq("event_type", "topup")
            .eq("balance_after", 0);
        }
        throw topupFlowErr;
      }

      const walletAfterTopup = await syncWallet(supabase, userId, "stripe-webhook-after-topup");
      const now = new Date();
      const activeStreams = Math.max(1, safeInt(walletAfterTopup.active_listing_count, 1));
      const projectedSeconds = Math.max(1, Math.floor(purchasedSeconds / activeStreams));
      const projectedExpire = new Date(now.getTime() + projectedSeconds * 1000);

      let ownerId: string | null = null;
      let adminBeneficiaryId: string | null = null;
      let { data: serverData, error: serverErr } = await supabase
        .from("servers")
        .select("owner_id,admin_beneficiary_id")
        .eq("id", listing.server_id)
        .single();
      if (isMissingAdminBeneficiaryColumnError(serverErr)) {
        const fallback = await supabase
          .from("servers")
          .select("owner_id")
          .eq("id", listing.server_id)
          .single();
        serverData = fallback.data ? { ...fallback.data, admin_beneficiary_id: null } : null;
        serverErr = fallback.error;
      }
      if (!serverErr) {
        ownerId = typeof serverData?.owner_id === "string" ? serverData.owner_id : null;
        adminBeneficiaryId = typeof serverData?.admin_beneficiary_id === "string" ? serverData.admin_beneficiary_id : null;
        if (ownerId && adminBeneficiaryId && ownerId === adminBeneficiaryId) {
          console.warn("Regra antifraude aplicada no webhook: owner_id e admin_beneficiary_id iguais. Ignorando repasse admin.");
          adminBeneficiaryId = null;
        }
      }

      if (ownerId || adminBeneficiaryId) {
        const stripeNetDetails = await fetchStripeNetDetails(paymentIntentId);
        const platformNetCents = stripeNetDetails.netCents ?? Math.round(totalCents * NET_ESTIMATE_RATIO);
        const grossAmount = centsToMoney(totalCents);
        const payoutStatus = projectedExpire <= now ? "eligible" : "pending";

        const recipients: Array<{ userId: string; role: "owner" | "admin"; ratio: number }> = [];
        if (ownerId) {
          recipients.push({ userId: ownerId, role: "owner", ratio: PARTNER_SHARE_RATIO });
        }
        if (adminBeneficiaryId) {
          recipients.push({ userId: adminBeneficiaryId, role: "admin", ratio: ADMIN_SHARE_RATIO });
        }

        for (const recipient of recipients) {
          const recipientNetCents = Math.round(platformNetCents * recipient.ratio);
          const expectedNetAmount = centsToMoney(recipientNetCents);
          let payoutInsertPayload: Record<string, unknown> = {
            owner_user_id: recipient.userId,
            payout_role: recipient.role,
            share_ratio: recipient.ratio,
            server_id: listing.server_id,
            listing_id: listing.id,
            payer_user_id: userId,
            checkout_session_id: sessionId,
            payment_intent_id: paymentIntentId,
            stripe_charge_id: stripeNetDetails.chargeId,
            stripe_balance_transaction_id: stripeNetDetails.balanceTransactionId,
            highlight_days: daysEquivalent,
            highlight_started_at: nowIso,
            highlight_expires_at: projectedExpire.toISOString(),
            currency: stripeCurrency || "BRL",
            gross_amount: grossAmount,
            expected_net_amount: expectedNetAmount,
            refunded_gross_amount: 0,
            refunded_net_amount: 0,
            payout_status: payoutStatus,
            notes: stripeNetDetails.netCents == null
              ? `Repasse ${recipient.role} calculado como ${(recipient.ratio * 100).toFixed(0)}% do líquido estimado. Modelo wallet: expiração projetada (${projectedSeconds}s).`
              : `Repasse ${recipient.role} calculado como ${(recipient.ratio * 100).toFixed(0)}% do líquido da Stripe. Modelo wallet: expiração projetada (${projectedSeconds}s).`,
          };

          let onConflict = "checkout_session_id,payout_role";
          let { error: payoutEventErr } = await supabase
            .from("partner_payout_events")
            .upsert(payoutInsertPayload, { onConflict });

          if (isMissingPayoutRoleColumnError(payoutEventErr) || isMissingShareRatioColumnError(payoutEventErr)) {
            // Backward compatibility with legacy schema (single row per checkout_session_id).
            if (recipient.role !== "owner") {
              continue;
            }
            if (isMissingPayoutRoleColumnError(payoutEventErr)) {
              const { payout_role: _payoutRole, ...rest } = payoutInsertPayload;
              payoutInsertPayload = rest;
            }
            if (isMissingShareRatioColumnError(payoutEventErr)) {
              const { share_ratio: _shareRatio, ...rest } = payoutInsertPayload;
              payoutInsertPayload = rest;
            }
            onConflict = "checkout_session_id";
            const fallback = await supabase
              .from("partner_payout_events")
              .upsert(payoutInsertPayload, { onConflict });
            payoutEventErr = fallback.error;
          }

          if (payoutEventErr && !isMissingPartnerPayoutTableError(payoutEventErr)) {
            throw payoutEventErr;
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
