import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import {
  WiseAppError,
  buildAccountSummary,
  createRecipientAccount,
  getPrimaryWiseProfile,
  getRecipientAccount,
  getWiseSourceCurrency,
  normalizeCountryCode,
  normalizeCurrencyCode,
  normalizeLegalType,
} from "../_shared/wise.ts";

type Payload = {
  countryCode?: string;
  targetCurrency?: string;
  legalType?: string;
  accountKind?: string;
  accountHolderName?: string;
  recipientPayload?: Record<string, unknown> | null;
  userToken?: string;
};

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

function getPixValue(payload: Record<string, unknown> | null) {
  return String(
    payload?.pixKeyValue
      || payload?.pixKey
      || payload?.key
      || "",
  ).trim();
}

function getPixKeyType(payload: Record<string, unknown> | null) {
  const value = String(
    payload?.pixKeyType
      || payload?.keyType
      || "",
  ).trim().toLowerCase();
  if (["cpf", "cnpj", "email", "phone", "random"].includes(value)) return value;
  return "";
}

function maskPixKeyValue(rawValue: string) {
  const value = String(rawValue || "").trim();
  if (!value) return "Chave Pix cadastrada";
  if (value.includes("@")) {
    const [local, domain = ""] = value.split("@");
    const start = local.slice(0, 2);
    const end = local.slice(-1);
    return `${start}${"*".repeat(Math.max(1, local.length - 3))}${end}@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 8) {
    return `***${digits.slice(-4)}`;
  }
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function getPixSummaryLabel(keyType: string) {
  switch (keyType) {
    case "cpf":
      return "Pix CPF";
    case "cnpj":
      return "Pix CNPJ";
    case "email":
      return "Pix e-mail";
    case "phone":
      return "Pix telefone";
    case "random":
      return "Pix aleatoria";
    default:
      return "Pix";
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const payload = (await req.json()) as Payload;
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado", 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);
    const userId = authData.user.id;

    const countryCode = normalizeCountryCode(payload.countryCode);
    const targetCurrency = normalizeCurrencyCode(payload.targetCurrency);
    const legalType = normalizeLegalType(payload.legalType);
    const accountKind = String(payload.accountKind || "").trim().toLowerCase() === "pix" ? "pix" : "bank";
    const accountHolderName = String(payload.accountHolderName || "").trim();
    const recipientPayload = payload.recipientPayload && typeof payload.recipientPayload === "object"
      ? payload.recipientPayload
      : null;

    if (!countryCode || countryCode.length !== 2) {
      return errorResponse("Informe um país de destino válido com 2 letras.", 400);
    }
    if (!targetCurrency || targetCurrency.length !== 3) {
      return errorResponse("Informe uma moeda de recebimento válida com 3 letras.", 400);
    }
    if (!accountHolderName) {
      return errorResponse("Informe o nome do titular da conta.", 400);
    }
    if (!recipientPayload || Object.keys(recipientPayload).length === 0) {
      return errorResponse("Os dados bancários da Wise não foram informados.", 400);
    }

    if (accountKind === "pix") {
      if (countryCode !== "BR") {
        return errorResponse("Chave Pix so pode ser cadastrada para contas do Brasil.", 400);
      }
      if (targetCurrency !== "BRL") {
        return errorResponse("Chave Pix so pode receber em BRL.", 400);
      }

      const pixKeyType = getPixKeyType(recipientPayload);
      const pixKeyValue = getPixValue(recipientPayload);
      if (!pixKeyType) {
        return errorResponse("Informe o tipo da chave Pix.", 400);
      }
      if (!pixKeyValue) {
        return errorResponse("Informe a chave Pix.", 400);
      }

      const accountSummary = `${getPixSummaryLabel(pixKeyType)} ${maskPixKeyValue(pixKeyValue)}`.trim();
      const { data: savedPixAccount, error: savePixErr } = await supabase
        .from("partner_payout_accounts")
        .upsert({
          user_id: userId,
          provider: "pix",
          wise_profile_id: null,
          wise_recipient_id: null,
          source_currency: "BRL",
          target_currency: "BRL",
          country_code: "BR",
          legal_type: legalType,
          account_holder_name: accountHolderName,
          account_summary: accountSummary,
          long_account_summary: accountSummary,
          display_fields: [
            { label: "Titular", value: accountHolderName },
            { label: "Tipo de chave", value: pixKeyType },
            { label: "Chave", value: maskPixKeyValue(pixKeyValue) },
          ],
          status: "active",
          metadata: {
            account_kind: "pix",
          },
          pix_key_type: pixKeyType,
          pix_key_value: pixKeyValue,
          last_sync_at: new Date().toISOString(),
        }, { onConflict: "user_id" })
        .select("*")
        .single();
      if (savePixErr) throw savePixErr;

      await supabase
        .from("users")
        .update({ is_partner: true })
        .eq("id", userId);

      return new Response(JSON.stringify({
        ok: true,
        account: savedPixAccount,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const profile = await getPrimaryWiseProfile();
    const profileId = Number(profile?.id || 0);
    if (!profileId) {
      return errorResponse("Nenhum profile Wise disponível para esta conta.", 500);
    }
    const recipient = await createRecipientAccount({
      profileId,
      countryCode,
      accountHolderName,
      targetCurrency,
      recipientPayload,
    });
    const recipientId = recipient?.id;
    if (!recipientId) {
      throw new WiseAppError("A Wise não retornou um recipient válido.", 502);
    }

    const recipientData = await getRecipientAccount(recipientId);
    const accountInfo = buildAccountSummary(recipientData);
    const sourceCurrency = getWiseSourceCurrency();

    const { data: savedAccount, error: saveErr } = await supabase
      .from("partner_payout_accounts")
      .upsert({
        user_id: userId,
        provider: "wise",
        wise_profile_id: Number(profileId),
        wise_recipient_id: Number(recipientId),
        source_currency: sourceCurrency,
        target_currency: targetCurrency,
        country_code: countryCode,
        legal_type: legalType,
        account_holder_name: accountHolderName,
        account_summary: accountInfo.accountSummary || null,
        long_account_summary: accountInfo.longAccountSummary || null,
        display_fields: accountInfo.displayFields,
        status: "active",
        metadata: {
          recipient_type: recipientData?.type || recipient?.type || null,
          account_kind: accountKind,
        },
        pix_key_type: null,
        pix_key_value: null,
        last_sync_at: new Date().toISOString(),
      }, { onConflict: "user_id" })
      .select("*")
      .single();
    if (saveErr) throw saveErr;

    await supabase
      .from("users")
      .update({ is_partner: true })
      .eq("id", userId);

    return new Response(JSON.stringify({
      ok: true,
      account: savedAccount,
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
