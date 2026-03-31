import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  userToken?: string;
  requestId?: string;
  status?: "approved" | "paid" | "rejected";
  note?: string | null;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const EMAIL_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/partner_withdraw_email` : null;

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
    if (req.method !== "POST") {
      return errorResponse("Método inválido.", 405);
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const payload = (await req.json().catch(() => ({}))) as Payload;
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado.", 401);

    const requestId = String(payload.requestId || "").trim();
    const nextStatus = String(payload.status || "").trim().toLowerCase();
    const note = String(payload.note || "").trim() || null;
    if (!requestId) return errorResponse("Solicitação inválida.", 400);
    if (!["approved", "paid", "rejected"].includes(nextStatus)) {
      return errorResponse("Status inválido.", 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida.", 401);

    const { data: adminUser, error: adminErr } = await supabase
      .from("users")
      .select("id,is_admin")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (adminErr) throw adminErr;
    if (!adminUser?.is_admin) return errorResponse("Apenas administradores podem revisar saques.", 403);

    const { data: requestRow, error: requestErr } = await supabase
      .from("partner_withdraw_requests")
      .select("id,user_id,provider,status,requested_amount,target_currency,note,wise_source_amount,wise_source_currency,wise_target_amount,wise_fee_amount,wise_fee_currency,wise_rate,approved_email_sent_at")
      .eq("id", requestId)
      .maybeSingle();
    if (requestErr) throw requestErr;
    if (!requestRow?.id) return errorResponse("Solicitação não encontrada.", 404);

    const updatePayload: Record<string, unknown> = {
      status: nextStatus,
      reviewed_by: authData.user.id,
      reviewed_at: new Date().toISOString(),
    };
    if (note) updatePayload.note = note;
    if (nextStatus === "paid") {
      updatePayload.paid_at = new Date().toISOString();
    }

    const { data: updatedRow, error: updateErr } = await supabase
      .from("partner_withdraw_requests")
      .update(updatePayload)
      .eq("id", requestId)
      .select("*")
      .single();
    if (updateErr) throw updateErr;

    if (["paid", "rejected"].includes(nextStatus) && !requestRow.approved_email_sent_at && EMAIL_ENDPOINT) {
      try {
        const { data: userRow, error: userErr } = await supabase
          .from("users")
          .select("email,first_name,locale")
          .eq("id", requestRow.user_id)
          .maybeSingle();
        if (userErr) throw userErr;

        const userEmail = String(userRow?.email || "").trim();
        if (userEmail) {
          const targetAmount = Number(
            requestRow.wise_target_amount
              || requestRow.requested_amount
              || 0,
          );
          const sourceAmount = Number(
            requestRow.wise_source_amount
              || requestRow.requested_amount
              || 0,
          );
          const feeAmount = Number(requestRow.wise_fee_amount || 0);
          const mailResponse = await fetch(EMAIL_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${SERVICE_KEY}`,
            },
            body: JSON.stringify({
              to: userEmail,
              firstName: userRow?.first_name || null,
              locale: userRow?.locale || "pt-BR",
              status: nextStatus,
              targetAmount,
              targetCurrency: String(requestRow.target_currency || "BRL"),
              sourceAmount,
              sourceCurrency: requestRow.wise_source_currency || "BRL",
              feeAmount,
              feeCurrency: requestRow.wise_fee_currency || "BRL",
              rate: Number(requestRow.wise_rate || 1) || 1,
              requestId: requestRow.id,
              note: note || requestRow.note || null,
            }),
          });
          if (!mailResponse.ok) {
            const body = await mailResponse.text().catch(() => "");
            throw new Error(`Falha ao enviar e-mail (${mailResponse.status}): ${body}`);
          }
          await supabase
            .from("partner_withdraw_requests")
            .update({ approved_email_sent_at: new Date().toISOString() })
            .eq("id", requestRow.id);
        }
      } catch (mailErr) {
        console.warn("Falha ao enviar e-mail de status do saque revisado", mailErr);
      }
    }

    return new Response(JSON.stringify({ ok: true, request: updatedRow }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno.", 500);
  }
});
