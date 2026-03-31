import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { getPartnerPayoutSummary } from "../_shared/partner_payout.ts";
import {
  WiseAppError,
  buildWiseTransferReference,
  cancelTransfer,
  createTransfer,
  createTransferQuote,
  extractQuoteFinancials,
  getPrimaryWiseProfile,
  getWiseSourceCurrency,
  normalizeCurrencyCode,
} from "../_shared/wise.ts";

type Payload = {
  userToken?: string;
  action?: "preview" | "create";
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const MIN_WITHDRAW_BRL = Number(Deno.env.get("PARTNER_WITHDRAW_MIN_BRL") || 50);

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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const payload = (await req.json().catch(() => ({}))) as Payload;
    const action = payload.action === "create" ? "create" : "preview";
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado", 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);
    const userId = authData.user.id;

    const { data: account, error: accountErr } = await supabase
      .from("partner_payout_accounts")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle();
    if (accountErr) throw accountErr;
    if (!account) {
      return errorResponse("Cadastre uma conta de recebimento antes de solicitar o saque.", 409);
    }

    const summary = await getPartnerPayoutSummary(supabase, userId);
    const availableAmount = Number(summary?.availableAmount || 0);
    if (!Number.isFinite(availableAmount) || availableAmount <= 0) {
      return errorResponse("Você não possui saldo disponível para saque.", 409);
    }
    if (availableAmount < MIN_WITHDRAW_BRL) {
      return errorResponse(`O valor mínimo para solicitar saque é R$ ${MIN_WITHDRAW_BRL.toFixed(2)}.`, 409);
    }

    const accountProvider = String(account.provider || "").trim().toLowerCase();
    const isPixAccount = accountProvider === "pix" || String(account?.metadata?.account_kind || "").trim().toLowerCase() === "pix";
    const requestedAmount = Number(availableAmount.toFixed(2));

    if (isPixAccount) {
      const preview = {
        grossAmount: requestedAmount,
        grossCurrency: "BRL",
        feeAmount: 0,
        feeCurrency: "BRL",
        netAmount: requestedAmount,
        netCurrency: "BRL",
        rate: 1,
        quoteId: null,
      };

      if (action === "preview") {
        return new Response(JSON.stringify({
          ok: true,
          action,
          minimumAmount: MIN_WITHDRAW_BRL,
          preview,
        }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      const { data: request, error: insertErr } = await supabase
        .from("partner_withdraw_requests")
        .insert({
          user_id: userId,
          partner_payout_account_id: account.id,
          provider: "pix",
          country_code: "BR",
          target_currency: "BRL",
          requested_amount: requestedAmount,
          status: "pending",
          account_snapshot: {
            account_summary: account.account_summary || null,
            long_account_summary: account.long_account_summary || null,
            account_holder_name: account.account_holder_name || null,
            pix_key_type: account.pix_key_type || null,
            pix_key_value: account.pix_key_value || null,
            metadata: account.metadata || {},
          },
          metadata: {
            source_currency: "BRL",
            summary_method: summary?.method || null,
            payout_method: "pix",
          },
        })
        .select("*")
        .single();
      if (insertErr) throw insertErr;

      return new Response(JSON.stringify({
        ok: true,
        action,
        request,
        minimumAmount: MIN_WITHDRAW_BRL,
        preview,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const recipientId = Number(account.wise_recipient_id || 0);
    if (!recipientId) {
      return errorResponse("A conta de recebimento não possui um destinatário ativo para saque.", 409);
    }

    const targetCurrency = normalizeCurrencyCode(account.target_currency);
    if (!targetCurrency) {
      return errorResponse("A conta de recebimento não possui moeda de destino configurada.", 409);
    }

    const profileId = Number(account.wise_profile_id || 0)
      || Number((await getPrimaryWiseProfile())?.id || 0);
    if (!profileId) {
      return errorResponse("Nenhum perfil de transferência disponível para esta conta.", 409);
    }

    const requestId = crypto.randomUUID();
    const sourceCurrency = normalizeCurrencyCode(account.source_currency) || getWiseSourceCurrency();
    const quote = await createTransferQuote({
      profileId,
      sourceCurrency,
      targetCurrency,
      sourceAmount: requestedAmount,
      targetAccount: recipientId,
    });
    const financials = extractQuoteFinancials(quote);
    if (!financials.quoteId) {
      throw new WiseAppError("Não foi possível gerar uma estimativa válida para o saque.", 502);
    }

    const preview = {
      grossAmount: financials.sourceAmount || requestedAmount,
      grossCurrency: financials.sourceCurrency || sourceCurrency,
      feeAmount: financials.feeAmount || 0,
      feeCurrency: financials.feeCurrency || financials.sourceCurrency || sourceCurrency || null,
      netAmount: financials.targetAmount || 0,
      netCurrency: financials.targetCurrency || targetCurrency,
      rate: financials.rate || null,
      quoteId: financials.quoteId,
    };

    if (action === "preview") {
      return new Response(JSON.stringify({
        ok: true,
        action,
        minimumAmount: MIN_WITHDRAW_BRL,
        preview,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const transferReference = buildWiseTransferReference(requestId);
    const transfer = await createTransfer({
      targetAccount: recipientId,
      quoteId: financials.quoteId,
      customerTransactionId: requestId,
      reference: transferReference,
    });
    const transferId = Number(transfer?.id || 0);
    if (!transferId) {
      throw new WiseAppError("Não foi possível criar a transferência do saque.", 502);
    }

    const insertPayload = {
      id: requestId,
      user_id: userId,
      partner_payout_account_id: account.id,
      provider: "wise",
      country_code: account.country_code || null,
      target_currency: targetCurrency || null,
      requested_amount: financials.sourceAmount || requestedAmount,
      status: "pending",
      wise_profile_id: profileId,
      wise_recipient_id: recipientId,
      wise_quote_id: financials.quoteId,
      wise_transfer_id: transferId,
      wise_transfer_status: String(transfer?.status || "incoming_payment_waiting"),
      wise_transfer_reference: transferReference,
      wise_source_currency: financials.sourceCurrency || sourceCurrency || null,
      wise_source_amount: financials.sourceAmount || null,
      wise_target_amount: financials.targetAmount || 0,
      wise_fee_currency: financials.feeCurrency || financials.sourceCurrency || sourceCurrency || null,
      wise_fee_amount: financials.feeAmount || 0,
      wise_rate: financials.rate || null,
      account_snapshot: {
        account_summary: account.account_summary || null,
        long_account_summary: account.long_account_summary || null,
        account_holder_name: account.account_holder_name || null,
        metadata: account.metadata || {},
      },
      metadata: {
        source_currency: sourceCurrency || null,
        summary_method: summary?.method || null,
        wise_quote: {
          id: financials.quoteId,
          source_amount: financials.sourceAmount || null,
          source_currency: financials.sourceCurrency || sourceCurrency || null,
          target_amount: financials.targetAmount || requestedAmount,
          target_currency: financials.targetCurrency || targetCurrency || null,
          fee_amount: financials.feeAmount || 0,
          fee_currency: financials.feeCurrency || financials.sourceCurrency || sourceCurrency || null,
          rate: financials.rate || null,
        },
      },
    };

    const { data: request, error: insertErr } = await supabase
      .from("partner_withdraw_requests")
      .insert(insertPayload)
      .select("*")
      .single();
    if (insertErr) {
      try {
        await cancelTransfer(transferId);
      } catch (cancelErr) {
        console.warn("Falha ao cancelar transferência após erro local", cancelErr);
      }
      throw insertErr;
    }

    return new Response(JSON.stringify({
      ok: true,
      action,
      request,
      minimumAmount: MIN_WITHDRAW_BRL,
      preview,
      wise: {
        quoteId: financials.quoteId,
        transferId,
      },
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    if (err instanceof WiseAppError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
