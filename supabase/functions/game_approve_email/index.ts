// supabase edge function: envia email ao usuário após aprovação/recusa de game
// Use supabase functions deploy index

import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";

// Patch edge runtime missing writeAll expected by smtp@0.7.0
if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

interface Payload {
  to: string;
  gameName: string;
  approved: boolean;
  note?: string;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

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

function buildTextContent(gameName: string, approved: boolean, note?: string) {
  if (approved) {
    return [
      "Olá,",
      "",
      `O game ${gameName} foi aprovado e já pode aparecer no marketplace da comunidade.`,
      "Se você tiver assets adicionais, responda este e-mail com as URLs atualizadas.",
      "",
      "Obrigado por colaborar com a comunidade Gimerr!",
    ].join("\n");
  }

  return [
    "Olá,",
    "",
    `Sua solicitação para o game ${gameName} foi recusada.`,
    note ? `Motivo: ${note}` : "Motivo: não informado.",
    "Você pode reenviar corrigindo as informações.",
  ].join("\n");
}

function buildHtmlContent(params: {
  gameName: string;
  approved: boolean;
  note?: string;
  logoUrl: string;
  appUrl: string;
}) {
  const gameName = escapeHtml(params.gameName);
  const safeNote = params.note ? toMultilineHtml(params.note) : "Não informado.";
  const title = params.approved
    ? `Seu game ${gameName} foi aprovado`
    : `Sua solicitação para ${gameName} foi recusada`;
  const subtitle = params.approved
    ? "Seu envio já pode aparecer no marketplace da comunidade."
    : "Revise os dados e envie novamente quando quiser.";
  const bodyMessage = params.approved
    ? `
      <p style="margin:0 0 14px;color:#233154;font-size:15px;line-height:1.7;">
        O game <strong>${gameName}</strong> foi aprovado e já pode aparecer no marketplace da comunidade.
      </p>
      <p style="margin:0 0 14px;color:#516081;font-size:14px;line-height:1.7;">
        Se você tiver assets adicionais, responda este e-mail com as URLs atualizadas.
      </p>
    `
    : `
      <p style="margin:0 0 12px;color:#233154;font-size:15px;line-height:1.7;">
        Sua solicitação para o game <strong>${gameName}</strong> foi recusada.
      </p>
      <div style="margin:0 0 14px;background:#fff2f4;border:1px solid #ffd6de;border-radius:10px;padding:12px 14px;color:#8f2f42;font-size:14px;line-height:1.6;">
        <strong>Motivo:</strong> ${safeNote}
      </div>
      <p style="margin:0 0 14px;color:#516081;font-size:14px;line-height:1.7;">
        Você pode reenviar corrigindo as informações e o website.
      </p>
    `;

  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f4f7ff;font-family:Arial,sans-serif;">
    <div style="background:
      radial-gradient(circle at 20% 20%, rgba(0,194,255,0.09), transparent 30%),
      radial-gradient(circle at 80% 0%, rgba(14,165,233,0.1), transparent 32%),
      linear-gradient(150deg, #f8faff 0%, #eef2fb 42%, #f9fbff 100%);
      padding:28px 10px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:collapse;background:#ffffff;border:1px solid #e0e6f4;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="padding:26px 24px;background:linear-gradient(120deg,#0d1b3b,#1b4fd3);">
                  <img src="${escapeHtml(params.logoUrl)}" alt="Gimerr" style="display:block;height:40px;width:auto;max-width:160px;" />
                  <h1 style="margin:16px 0 8px;color:#ffffff;font-size:24px;line-height:1.2;">${title}</h1>
                  <p style="margin:0;color:#dbe6ff;font-size:14px;line-height:1.6;">${subtitle}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:24px;">
                  <p style="margin:0 0 14px;color:#233154;font-size:15px;line-height:1.7;">Olá,</p>
                  ${bodyMessage}
                  <p style="margin:0 0 18px;color:#233154;font-size:14px;line-height:1.7;">Obrigado por colaborar com a comunidade Gimerr.</p>
                  <a href="${escapeHtml(params.appUrl)}" style="display:inline-block;padding:11px 18px;background:linear-gradient(120deg,#00c2ff,#0ea5e9);border-radius:999px;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;">Ir para o Gimerr</a>
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
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    const body = (await req.json()) as Payload;
    if (!body.to || !body.gameName) {
      return new Response(JSON.stringify({ ok: false, error: "Payload inválido" }), {
        status: 400,
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const host = Deno.env.get("SMTP_HOST");
    const port = Number(Deno.env.get("SMTP_PORT") || "465");
    const user = Deno.env.get("SMTP_USER");
    const pass = Deno.env.get("SMTP_PASS");
    const baseUrlRaw = Deno.env.get("EMAIL_ASSET_BASE_URL") || "http://localhost:8788";
    const baseUrl = baseUrlRaw.replace(/\/+$/, "");
    const logoUrl = `${baseUrl}/img/logo.png`;

    if (!host || !user || !pass) {
      return new Response(JSON.stringify({ ok: false, error: "Variáveis SMTP faltando" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const client = new SmtpClient();
    await client.connectTLS({ hostname: host, port, username: user, password: pass });

    const subject = body.approved
      ? `Seu game ${body.gameName} foi aprovado`
      : `Sua solicitação para ${body.gameName} foi recusada`;

    const textContent = buildTextContent(body.gameName, body.approved, body.note);
    const htmlContent = buildHtmlContent({
      gameName: body.gameName,
      approved: body.approved,
      note: body.note,
      logoUrl,
      appUrl: baseUrl,
    });

    await client.send({
      from: user,
      to: body.to,
      subject,
      content: textContent,
      html: htmlContent,
    });

    await client.close();
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", ...corsHeaders } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  }
});
