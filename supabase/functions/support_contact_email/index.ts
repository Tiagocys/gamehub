import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { enforceUserRateLimit, RateLimitError } from "../_shared/rate_limit.ts";

type Payload = {
  subject?: string;
  message?: string;
  userToken?: string;
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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResponse({ ok: false, error: "PROJECT_URL ou SERVICE_ROLE_KEY ausentes" }, 500);
    }

    const payload = (await req.json()) as Payload;
    const subject = String(payload.subject || "").trim();
    const message = String(payload.message || "").trim();
    if (subject.length < 5 || subject.length > 120) {
      return jsonResponse({ ok: false, error: "Assunto inválido." }, 400);
    }
    if (message.length < 20 || message.length > 5000) {
      return jsonResponse({ ok: false, error: "Mensagem inválida." }, 400);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const headerToken = authHeader.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "").trim()
      : "";
    const bodyToken = String(payload.userToken || "").trim();
    const token = bodyToken || headerToken;
    if (!token) {
      return jsonResponse({ ok: false, error: "Não autorizado" }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return jsonResponse({ ok: false, error: "Sessão inválida" }, 401);
    }

    const { data: profile, error: profileErr } = await supabase
      .from("users")
      .select("id,email,first_name,last_name,phone_verified")
      .eq("id", authData.user.id)
      .single();
    if (profileErr || !profile) {
      return jsonResponse({ ok: false, error: "Perfil não encontrado" }, 404);
    }
    if (!profile.phone_verified) {
      return jsonResponse({ ok: false, error: "Verifique seu telefone antes de enviar uma mensagem ao suporte." }, 403);
    }

    await enforceUserRateLimit(supabase, authData.user.id, "support_contact_email", {
      maxCount: 5,
      windowSeconds: 60 * 60,
      bucketSeconds: 60,
      message: "Muitas tentativas de contato. Aguarde alguns minutos e tente novamente.",
    });

    const { data: existingPending, error: existingPendingErr } = await supabase
      .from("support_requests")
      .select("id,status")
      .eq("user_id", authData.user.id)
      .eq("status", "pending")
      .maybeSingle();
    if (existingPendingErr) {
      throw existingPendingErr;
    }
    if (existingPending?.id) {
      return jsonResponse({
        ok: false,
        error: "Você tem um pedido de ajuda pendente, aguarde uma resposta da nossa equipe.",
      }, 409);
    }

    const insertPayload = {
      user_id: authData.user.id,
      subject,
      message,
      status: "pending",
      handled_at: null,
      handled_by_admin_id: null,
      updated_at: new Date().toISOString(),
    };
    const { data: supportRequest, error: insertErr } = await supabase
      .from("support_requests")
      .insert(insertPayload)
      .select("id,status,updated_at")
      .single();
    if (insertErr) {
      throw insertErr;
    }

    return jsonResponse({
      ok: true,
      requestId: supportRequest?.id || null,
      status: supportRequest?.status || "pending",
    });
  } catch (err) {
    console.error(err);
    if (err instanceof RateLimitError) {
      return jsonResponse({ ok: false, error: err.message }, err.status);
    }
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : "Erro ao enviar e-mail" }, 500);
  }
});
