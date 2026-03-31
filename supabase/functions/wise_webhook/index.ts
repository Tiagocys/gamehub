import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { mapWiseTransferStateToRequestStatus } from "../_shared/wise.ts";

type WiseWebhookPayload = {
  subscription_id?: string;
  event_type?: string;
  sent_at?: string;
  data?: {
    resource?: {
      id?: number | string;
      profile_id?: number | string;
      account_id?: number | string;
      type?: string;
    };
    transfer_id?: number | string;
    profile_id?: number | string;
    current_state?: string;
    previous_state?: string;
    occurred_at?: string;
    failure_reason_code?: string;
    failure_description?: string;
  };
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const EMAIL_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/partner_withdraw_email` : null;
const ALLOWED_SUBSCRIPTION_IDS = new Set(
  String(Deno.env.get("WISE_WEBHOOK_SUBSCRIPTION_IDS") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

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

function getTransferId(payload: WiseWebhookPayload) {
  return Number(
    payload?.data?.resource?.id
      || payload?.data?.transfer_id
      || 0,
  ) || 0;
}

function parseEventTime(value: string | null | undefined) {
  const iso = String(value || "").trim();
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isNewerOrEqualEvent(nextValue: string | null, previousValue: string | null) {
  if (!nextValue) return true;
  if (!previousValue) return true;
  return Date.parse(nextValue) >= Date.parse(previousValue);
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

    const raw = await req.text();
    const payload = (raw ? JSON.parse(raw) : {}) as WiseWebhookPayload;
    const subscriptionId = String(payload.subscription_id || "").trim();
    if (ALLOWED_SUBSCRIPTION_IDS.size > 0 && (!subscriptionId || !ALLOWED_SUBSCRIPTION_IDS.has(subscriptionId))) {
      return errorResponse("Webhook Wise não autorizado.", 401);
    }

    const eventType = String(payload.event_type || "").trim();
    if (!eventType) {
      return errorResponse("Webhook Wise sem event_type.", 400);
    }
    if (!["transfers#state-change", "transfers#payout-failure"].includes(eventType)) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: "event_type_ignored" }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const transferId = getTransferId(payload);
    if (!transferId) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: "missing_transfer_id" }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: requestRow, error: requestErr } = await supabase
      .from("partner_withdraw_requests")
      .select("id,user_id,status,note,metadata,approved_email_sent_at,wise_last_event_at,requested_amount,target_currency,wise_target_amount,wise_source_amount,wise_source_currency,wise_fee_amount,wise_fee_currency,wise_rate,wise_transfer_status")
      .eq("wise_transfer_id", transferId)
      .maybeSingle();
    if (requestErr) throw requestErr;
    if (!requestRow?.id) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: "request_not_found" }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const occurredAt = parseEventTime(payload?.data?.occurred_at || payload?.sent_at) || new Date().toISOString();
    const previousEventAt = parseEventTime(requestRow.wise_last_event_at);
    if (!isNewerOrEqualEvent(occurredAt, previousEventAt)) {
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: "stale_event" }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const currentState = String(
      payload?.data?.current_state
        || requestRow.wise_transfer_status
        || "",
    ).trim();
    const mappedStatus = eventType === "transfers#payout-failure"
      ? "failed"
      : mapWiseTransferStateToRequestStatus(currentState);

    const failureReason = String(payload?.data?.failure_reason_code || "").trim();
    const failureDescription = String(payload?.data?.failure_description || "").trim();
    const nextMetadata = {
      ...(requestRow.metadata && typeof requestRow.metadata === "object" ? requestRow.metadata : {}),
      wise_webhook: {
        event_type: eventType,
        subscription_id: subscriptionId || null,
        current_state: currentState || null,
        previous_state: String(payload?.data?.previous_state || "").trim() || null,
        occurred_at: occurredAt,
        failure_reason_code: failureReason || null,
        failure_description: failureDescription || null,
      },
    };

    const updatePayload: Record<string, unknown> = {
      status: mappedStatus,
      wise_transfer_status: currentState || requestRow.wise_transfer_status || null,
      wise_last_event_at: occurredAt,
      metadata: nextMetadata,
    };
    if (mappedStatus === "paid") {
      updatePayload.paid_at = occurredAt;
    }
    if (mappedStatus === "failed" && failureDescription && !requestRow.note) {
      updatePayload.note = failureDescription;
    }

    const { error: updateErr } = await supabase
      .from("partner_withdraw_requests")
      .update(updatePayload)
      .eq("id", requestRow.id);
    if (updateErr) throw updateErr;

    if (["paid", "rejected", "failed", "cancelled"].includes(mappedStatus) && !requestRow.approved_email_sent_at && EMAIL_ENDPOINT) {
      try {
        const { data: userRow, error: userErr } = await supabase
          .from("users")
          .select("email,first_name,locale")
          .eq("id", requestRow.user_id)
          .maybeSingle();
        if (userErr) throw userErr;

        const userEmail = String(userRow?.email || "").trim();
        if (userEmail) {
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
              status: mappedStatus,
              targetAmount: Number(requestRow.wise_target_amount || 0),
              targetCurrency: String(requestRow.target_currency || "BRL"),
              sourceAmount: Number(requestRow.requested_amount || requestRow.wise_source_amount || 0),
              sourceCurrency: requestRow.wise_source_currency || null,
              feeAmount: Number(requestRow.wise_fee_amount || 0),
              feeCurrency: requestRow.wise_fee_currency || null,
              rate: Number(requestRow.wise_rate || 0) || null,
              requestId: requestRow.id,
              note: failureDescription || requestRow.note || null,
            }),
          });
          if (!mailResponse.ok) {
            const mailBody = await mailResponse.text().catch(() => "");
            throw new Error(`Falha no endpoint de e-mail (${mailResponse.status}): ${mailBody}`);
          }
          await supabase
            .from("partner_withdraw_requests")
            .update({ approved_email_sent_at: new Date().toISOString() })
            .eq("id", requestRow.id);
        }
      } catch (mailErr) {
        console.warn("Falha ao enviar e-mail de status do saque", mailErr);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      requestId: requestRow.id,
      transferId,
      status: mappedStatus,
      currentState: currentState || null,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
