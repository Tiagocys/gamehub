import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";

if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

type Payload = {
  requestId?: string;
  responseMessage?: string;
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

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toMultilineHtml(value: string) {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

function normalizeLocale(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.startsWith("pt")) return "pt-BR";
  if (normalized.startsWith("es")) return "es";
  return "en";
}

function getCopy(locale: string) {
  if (locale === "pt-BR") {
    return {
      lang: "pt-BR",
      subjectPrefix: "Resposta do suporte do Gimerr",
      title: "Sua mensagem recebeu uma resposta",
      greeting: "Olá",
      lead: "O suporte do Gimerr respondeu à sua solicitação.",
      originalLabel: "Assunto original",
      responseLabel: "Resposta do suporte",
      footer: "Se precisar complementar a solicitação, volte para a página de ajuda e atualize sua mensagem.",
    };
  }
  if (locale === "es") {
    return {
      lang: "es",
      subjectPrefix: "Respuesta del soporte de Gimerr",
      title: "Tu mensaje recibió una respuesta",
      greeting: "Hola",
      lead: "El soporte de Gimerr respondió a tu solicitud.",
      originalLabel: "Asunto original",
      responseLabel: "Respuesta del soporte",
      footer: "Si necesitas añadir más contexto, vuelve a la página de ayuda y actualiza tu mensaje.",
    };
  }
  return {
    lang: "en",
    subjectPrefix: "Reply from Gimerr support",
    title: "Your message has a reply",
    greeting: "Hello",
    lead: "Gimerr support replied to your request.",
    originalLabel: "Original subject",
    responseLabel: "Support reply",
    footer: "If you need to add more context, go back to the help page and update your message.",
  };
}

async function sendSupportReplyEmail(params: {
  to: string;
  firstName: string;
  locale: string;
  originalSubject: string;
  responseMessage: string;
}) {
  const host = Deno.env.get("SMTP_HOST");
  const port = Number(Deno.env.get("SMTP_PORT") || "465");
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  const baseUrlRaw = Deno.env.get("EMAIL_ASSET_BASE_URL") || "http://localhost:8788";
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");
  const logoUrl = `${baseUrl}/img/logo.png`;
  const copy = getCopy(params.locale);

  if (!host || !user || !pass) {
    throw new Error("SMTP não configurado.");
  }

  const subject = `${copy.subjectPrefix}: ${params.originalSubject}`;
  const textContent = [
    `${copy.greeting} ${params.firstName || ""}`.trim(),
    "",
    copy.lead,
    "",
    `${copy.originalLabel}: ${params.originalSubject}`,
    "",
    `${copy.responseLabel}:`,
    params.responseMessage,
    "",
    copy.footer,
  ].join("\n");

  const htmlContent = `
<!DOCTYPE html>
<html lang="${escapeHtml(copy.lang)}">
  <body style="margin:0;padding:0;background:#f4f7ff;font-family:Arial,sans-serif;">
    <div style="padding:28px 10px;background:
      radial-gradient(circle at 20% 20%, rgba(0,194,255,0.09), transparent 30%),
      radial-gradient(circle at 80% 0%, rgba(14,165,233,0.1), transparent 32%),
      linear-gradient(150deg, #f8faff 0%, #eef2fb 42%, #f9fbff 100%);">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:collapse;background:#ffffff;border:1px solid #e0e6f4;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="padding:26px 24px;background:linear-gradient(120deg,#0d1b3b,#1b4fd3);">
                  <img src="${escapeHtml(logoUrl)}" alt="Gimerr" style="display:block;height:40px;width:auto;max-width:160px;" />
                  <h1 style="margin:16px 0 8px;color:#ffffff;font-size:24px;line-height:1.2;">${escapeHtml(copy.title)}</h1>
                  <p style="margin:0;color:#dbe6ff;font-size:14px;line-height:1.6;">${escapeHtml(copy.lead)}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:24px;">
                  <p style="margin:0 0 14px;color:#233154;font-size:15px;line-height:1.7;">${escapeHtml(`${copy.greeting} ${params.firstName || ""}`.trim())},</p>
                  <div style="margin:0 0 14px;background:#f7f9fc;border:1px solid #e0e6f4;border-radius:12px;padding:14px 16px;color:#233154;font-size:14px;line-height:1.7;">
                    <strong>${escapeHtml(copy.originalLabel)}:</strong> ${escapeHtml(params.originalSubject)}
                  </div>
                  <div style="background:#ffffff;border:1px solid #d7e3ff;border-radius:12px;padding:14px 16px;color:#233154;font-size:14px;line-height:1.7;">
                    <div style="margin:0 0 8px;color:#516081;font-size:13px;font-weight:700;">${escapeHtml(copy.responseLabel)}</div>
                    ${toMultilineHtml(params.responseMessage)}
                  </div>
                  <p style="margin:16px 0 0;color:#516081;font-size:13px;line-height:1.7;">${escapeHtml(copy.footer)}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>
  `.trim();

  const client = new SmtpClient();
  await client.connectTLS({ hostname: host, port, username: user, password: pass });
  await client.send({
    from: user,
    to: params.to,
    subject,
    content: textContent,
    html: htmlContent,
  });
  await client.close();
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
    const requestId = String(payload.requestId || "").trim();
    const responseMessage = String(payload.responseMessage || "").trim();
    if (!requestId) {
      return jsonResponse({ ok: false, error: "requestId é obrigatório." }, 400);
    }
    if (responseMessage.length < 10 || responseMessage.length > 5000) {
      return jsonResponse({ ok: false, error: "A resposta deve ter entre 10 e 5000 caracteres." }, 400);
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

    const { data: adminProfile, error: adminProfileErr } = await supabase
      .from("users")
      .select("id,is_admin")
      .eq("id", authData.user.id)
      .single();
    if (adminProfileErr || !adminProfile?.is_admin) {
      return jsonResponse({ ok: false, error: "Acesso restrito aos admins." }, 403);
    }

    const { data: supportRequest, error: requestErr } = await supabase
      .from("support_requests")
      .select("id,user_id,subject,message,status")
      .eq("id", requestId)
      .single();
    if (requestErr || !supportRequest) {
      return jsonResponse({ ok: false, error: "Solicitação não encontrada." }, 404);
    }
    if (String(supportRequest.status || "") !== "pending") {
      return jsonResponse({ ok: false, error: "Esta solicitação já foi tratada." }, 409);
    }

    const { data: targetUser, error: targetUserErr } = await supabase
      .from("users")
      .select("id,email,first_name,last_name,locale")
      .eq("id", supportRequest.user_id)
      .single();
    if (targetUserErr || !targetUser) {
      return jsonResponse({ ok: false, error: "Usuário da solicitação não encontrado." }, 404);
    }

    const targetEmail = String(targetUser.email || "").trim();
    if (!targetEmail) {
      return jsonResponse({ ok: false, error: "O usuário não possui e-mail válido para resposta." }, 400);
    }

    const firstName = String(targetUser.first_name || "").trim()
      || String(targetUser.email || "").trim().split("@")[0]
      || "player";
    const locale = normalizeLocale(String(targetUser.locale || ""));

    await sendSupportReplyEmail({
      to: targetEmail,
      firstName,
      locale,
      originalSubject: String(supportRequest.subject || "").trim(),
      responseMessage,
    });

    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("support_requests")
      .update({
        status: "handled",
        response_message: responseMessage,
        handled_at: now,
        handled_by_admin_id: authData.user.id,
        updated_at: now,
      })
      .eq("id", requestId);
    if (updateErr) {
      throw updateErr;
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : "Erro ao responder solicitação" }, 500);
  }
});
