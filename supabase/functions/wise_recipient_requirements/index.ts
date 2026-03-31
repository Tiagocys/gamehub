import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import {
  WiseAppError,
  fetchRecipientRequirements,
  normalizeCountryCode,
  normalizeCurrencyCode,
  normalizeLegalType,
} from "../_shared/wise.ts";

type Payload = {
  countryCode?: string;
  targetCurrency?: string;
  legalType?: string;
  recipientPayload?: Record<string, unknown> | null;
  userToken?: string;
  locale?: string;
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

    const countryCode = normalizeCountryCode(payload.countryCode);
    const targetCurrency = normalizeCurrencyCode(payload.targetCurrency);
    const legalType = normalizeLegalType(payload.legalType);
    if (!countryCode || countryCode.length !== 2) {
      return errorResponse("Informe um país de destino válido com 2 letras.", 400);
    }
    if (!targetCurrency || targetCurrency.length !== 3) {
      return errorResponse("Informe uma moeda de recebimento válida com 3 letras.", 400);
    }

    const requirements = await fetchRecipientRequirements({
      quoteId: "",
      countryCode,
      targetCurrency,
      legalType,
      recipientPayload: payload.recipientPayload || null,
      locale: String(payload.locale || "").trim() || undefined,
    });

    return new Response(JSON.stringify({
      ok: true,
      profileId: null,
      profileType: null,
      sourceCurrency: targetCurrency,
      targetCurrency,
      countryCode,
      legalType,
      quoteId: null,
      requirements,
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
