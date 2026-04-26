import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import {
  DAY_SECONDS,
  isMissingWalletTableError,
  safeInt,
  syncHighlightWallet,
} from "../_shared/highlight_wallet.ts";
import { ensurePartnerWallet, isMissingPartnerWalletTablesError } from "../_shared/partner_wallet.ts";

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
const OWNER_SHARE_RATIO = 0.5;
const ADMIN_BENEFICIARY_SHARE_RATIO = 0.25;
const PRICE_PER_DAY_CENTS = 600;
const DEFAULT_USD_BRL_RATE = 5.5;
const SUPPORTED_CHECKOUT_CURRENCIES = new Set([
  "BRL",
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "NZD",
  "MXN",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
]);

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

function normalizePositiveNumber(value: unknown, fallback = 0) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function centsToMoney(cents: number) {
  return Number((Math.max(0, cents) / 100).toFixed(2));
}

function getBrlFxRate(value?: unknown) {
  const envRate = Number(Deno.env.get("USD_BRL_RATE") || DEFAULT_USD_BRL_RATE);
  const fallback = Number.isFinite(envRate) && envRate > 0 ? envRate : DEFAULT_USD_BRL_RATE;
  return normalizePositiveNumber(value, fallback);
}

function normalizeBusinessCurrency(value: unknown) {
  const currency = String(value || "").trim().toUpperCase();
  return SUPPORTED_CHECKOUT_CURRENCIES.has(currency) ? currency : "BRL";
}

function normalizeToBrlCents(cents: number, currency: string, brlFxRate: number) {
  if (currency !== "BRL") {
    return Math.max(0, Math.round(cents * brlFxRate));
  }
  return Math.max(0, Math.round(cents));
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
      const walletTarget = String(metadata.wallet_target || "").trim().toLowerCase();
      const listingIdRaw = typeof metadata.listing_id === "string" ? metadata.listing_id.trim() : "";
      const listingId = listingIdRaw || null;
      const userId = typeof metadata.user_id === "string" ? metadata.user_id : "";
      const amountBRL = normalizeMoney(metadata.amount_brl);
      const totalCents = amountBRL > 0
        ? Math.round(amountBRL * 100)
        : normalizeAmountCents(metadata.total_cents || session?.amount_total || 0);
      const checkoutTotalCents = normalizeAmountCents(metadata.checkout_total_cents || session?.amount_total || totalCents);
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
      const checkoutCurrency = normalizeBusinessCurrency(metadata.checkout_currency || session?.currency);
      const brlFxRate = checkoutCurrency === "BRL" ? 1 : getBrlFxRate(metadata.fx_rate);
      if (!userId || !sessionId) {
        return errorResponse("Metadata incompleta no checkout", 400);
      }

      const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
      if (walletTarget === "partner") {
        const nowIso = new Date().toISOString();
        const reservePayload = {
          user_id: userId,
          event_type: "topup",
          amount_delta_cents: totalCents,
          balance_after_cents: 0,
          checkout_session_id: sessionId,
          payment_intent_id: paymentIntentId,
          currency: "BRL",
          metadata: {
            source: "stripe_webhook",
            wallet_target: "partner",
            checkout_currency: checkoutCurrency,
            checkout_amount_paid: Number((checkoutTotalCents / 100).toFixed(2)),
            checkout_country_code: String(metadata.checkout_country_code || "").trim().toUpperCase() || null,
            fx_rate: brlFxRate,
          },
        };
        let topupReserved = false;
        let topupApplied = false;
        try {
          const { error: reserveErr } = await supabase
            .from("partner_wallet_events")
            .insert(reservePayload);
          if (reserveErr) {
            if (reserveErr.code === "23505") {
              return new Response(JSON.stringify({ ok: true, duplicate: true }), {
                headers: { "content-type": "application/json", ...corsHeaders },
              });
            }
            if (!isMissingPartnerWalletTablesError(reserveErr)) {
              throw reserveErr;
            }
          } else {
            topupReserved = true;
          }

          const beforeWallet = await ensurePartnerWallet(supabase, userId, nowIso);
          const nextAvailableCents = safeInt(beforeWallet.available_cents) + totalCents;
          const nextTotalPurchasedCents = safeInt(beforeWallet.total_purchased_cents) + totalCents;
          const { data: toppedWallet, error: topupErr } = await supabase
            .from("partner_wallets")
            .update({
              available_cents: nextAvailableCents,
              total_purchased_cents: nextTotalPurchasedCents,
              last_consumed_at: nowIso,
            })
            .eq("user_id", userId)
            .select("available_cents")
            .single();
          if (topupErr) throw topupErr;
          topupApplied = true;

          await supabase
            .from("partner_wallet_events")
            .update({
              balance_after_cents: safeInt(toppedWallet?.available_cents, nextAvailableCents),
            })
            .eq("checkout_session_id", sessionId)
            .eq("event_type", "topup");
        } catch (partnerTopupErr) {
          if (topupReserved && !topupApplied) {
            await supabase
              .from("partner_wallet_events")
              .delete()
              .eq("checkout_session_id", sessionId)
              .eq("event_type", "topup");
          }
          throw partnerTopupErr;
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      let listing: {
        id: string;
        user_id: string;
        server_id: string | null;
        status: string;
        highlight_status: string | null;
      } | null = null;
      if (listingId) {
        const { data: listingData, error: listingErr } = await supabase
          .from("listings")
          .select("id,user_id,server_id,status,highlight_status")
          .eq("id", listingId)
          .eq("user_id", userId)
          .maybeSingle();
        if (!listingErr && listingData) {
          listing = listingData;
        } else {
          console.warn("Stripe webhook: listing_id ausente/inválido para repasse. Top-up será aplicado sem vínculo.", {
            listing_id: listingId,
            user_id: userId,
            error: listingErr?.message || null,
          });
        }
      }

      const nowIso = new Date().toISOString();
      const baseEventPayload = {
        user_id: userId,
        event_type: "topup",
        amount_delta_cents: totalCents,
        balance_after_cents: 0,
        listing_id: listing?.id || null,
        checkout_session_id: sessionId,
        payment_intent_id: paymentIntentId,
        amount_paid: Number((totalCents / 100).toFixed(2)),
        currency: "BRL",
          metadata: {
            days: daysEquivalent,
            purchased_seconds: purchasedSeconds,
            source: "stripe_webhook",
            checkout_currency: checkoutCurrency,
            checkout_amount_paid: Number((checkoutTotalCents / 100).toFixed(2)),
            fx_rate: brlFxRate,
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

        const beforeTopup = await syncHighlightWallet(supabase, userId, "stripe-webhook-before-topup");
        const nextAvailableCents = safeInt(beforeTopup.availableCents) + totalCents;
        const nextTotalPurchasedCents = safeInt(beforeTopup.totalPurchasedCents) + totalCents;
        const { data: toppedWallet, error: topupErr } = await supabase
          .from("wallets")
          .update({
            available_cents: nextAvailableCents,
            total_purchased_cents: nextTotalPurchasedCents,
            last_consumed_at: nowIso,
          })
          .eq("user_id", userId)
          .select("user_id,available_cents,total_purchased_cents,total_consumed_cents,active_listing_count,last_consumed_at")
          .single();
        if (topupErr) throw topupErr;
        topupApplied = true;

        const { error: confirmEventErr } = await supabase
          .from("wallet_events")
          .update({
            balance_after_cents: safeInt(toppedWallet?.available_cents),
          })
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
            .eq("balance_after_cents", 0);
        }
        throw topupFlowErr;
      }

      const walletAfterTopup = await syncHighlightWallet(supabase, userId, "stripe-webhook-after-topup");
      const now = new Date();
      const activeStreams = Math.max(1, safeInt(walletAfterTopup.activeListingCount, 1));
      const projectedSeconds = Math.max(1, Math.floor(purchasedSeconds / activeStreams));
      const projectedExpire = new Date(now.getTime() + projectedSeconds * 1000);

      let ownerId: string | null = null;
      let adminBeneficiaryId: string | null = null;
      if (listing?.server_id) {
        let { data: serverData, error: serverErr } = await supabase
          .from("servers")
          .select("owner_id,admin_beneficiary_id")
          .eq("id", listing.server_id)
          .single();
        if (serverErr && String(serverErr.message || "").includes("admin_beneficiary_id")) {
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
          adminBeneficiaryId = typeof serverData?.admin_beneficiary_id === "string"
            ? serverData.admin_beneficiary_id
            : null;
        }
      }

      if ((ownerId || adminBeneficiaryId) && listing) {
        const stripeNetDetails = await fetchStripeNetDetails(paymentIntentId);
        const platformNetCents = stripeNetDetails.netCents == null
          ? Math.round(totalCents * NET_ESTIMATE_RATIO)
          : normalizeToBrlCents(stripeNetDetails.netCents, checkoutCurrency, brlFxRate);
        const grossAmount = centsToMoney(totalCents);
        const payoutStatus = projectedExpire <= now ? "eligible" : "pending";

        const recipients: Array<{ userId: string; role: "owner" | "admin"; ratio: number }> = [];
        if (ownerId) {
          recipients.push({ userId: ownerId, role: "owner", ratio: OWNER_SHARE_RATIO });
        }
        if (adminBeneficiaryId && adminBeneficiaryId !== ownerId) {
          recipients.push({
            userId: adminBeneficiaryId,
            role: "admin",
            ratio: ADMIN_BENEFICIARY_SHARE_RATIO,
          });
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
            currency: "BRL",
            gross_amount: grossAmount,
            expected_net_amount: expectedNetAmount,
            refunded_gross_amount: 0,
            refunded_net_amount: 0,
            payout_status: payoutStatus,
            notes: stripeNetDetails.netCents == null
              ? `Repasse ${recipient.role} calculado como ${(recipient.ratio * 100).toFixed(0)}% do líquido estimado. Modelo wallet: expiração projetada (${projectedSeconds}s).`
              : checkoutCurrency !== "BRL"
                ? `Repasse ${recipient.role} calculado como ${(recipient.ratio * 100).toFixed(0)}% do líquido da Stripe convertido de ${checkoutCurrency} para BRL pela taxa ${brlFxRate.toFixed(4)}. Modelo wallet: expiração projetada (${projectedSeconds}s).`
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
