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
  gameId?: string;
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

function buildTextContent(params: { gameName: string; gameId?: string; approved: boolean; appUrl: string }) {
  const targetUrl = params.approved && params.gameId
    ? `${params.appUrl}/game.html?id=${encodeURIComponent(params.gameId)}`
    : params.appUrl;
  if (params.approved) {
    return [
      "Olá,",
      "",
      `O game "${params.gameName}" foi aprovado.`,
      `Você já pode criar anúncios para o game "${params.gameName}"!`,
      "",
      "Ir para o Gimerr:",
      targetUrl,
    ].join("\n");
  }

  return [
    "Olá,",
    "",
    `O game "${params.gameName}" não foi aprovado.`,
    "Verifique o website enviado.",
    "Quaisquer dúvidas entre em contato com o suporte através do email admin@gimerr.com",
    "",
    "Ir para o Gimerr:",
    params.appUrl,
  ].join("\n");
}

function buildHtmlContent(params: {
  gameName: string;
  gameId?: string;
  approved: boolean;
  note?: string;
  logoUrl: string;
  appUrl: string;
}) {
  const gameName = escapeHtml(params.gameName);
  const targetUrl = params.approved && params.gameId
    ? `${params.appUrl}/game.html?id=${encodeURIComponent(params.gameId)}`
    : params.appUrl;
  const title = params.approved
    ? `O game "${gameName}" foi aprovado`
    : `O game "${gameName}" não foi aprovado`;
  const bodyMessage = params.approved
    ? `
      <p style="margin:0 0 12px;color:#101a2e;font-size:16px;line-height:1.7;font-weight:700;">
        Sua solicitação foi aprovada.
      </p>
      <p style="margin:0 0 12px;color:#516081;font-size:15px;line-height:1.7;">
        Você já pode criar anúncios para o game "${gameName}".
      </p>
      <p style="margin:0 0 16px;color:#516081;font-size:14px;line-height:1.7;">
        Acesse a página do game clicando no botão abaixo:
      </p>
    `
    : `
      <p style="margin:0 0 14px;color:#516081;font-size:14px;line-height:1.7;">
        Verifique o website enviado. Quaisquer dúvidas entre em contato com o suporte através do email
        <a href="mailto:admin@gimerr.com" style="color:#76a8ff;text-decoration:none;font-weight:700;">admin@gimerr.com</a>.
      </p>
    `;

  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f4f7ff;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4f7ff;">
      <tr>
        <td align="center" style="padding:28px 10px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e0e6f4;border-radius:16px;overflow:hidden;">
            <tr>
              <td align="left" bgcolor="#ffffff" style="padding:26px 24px;background-color:#ffffff;">
                <img src="${escapeHtml(params.logoUrl)}" alt="Gimerr" style="display:block;height:40px;width:auto;max-width:160px;border:0;outline:none;text-decoration:none;" />
                <div style="margin-top:16px;font-size:24px;line-height:1.2;font-weight:700;color:#101a2e;">
                  ${title}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                ${bodyMessage}
                <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;">
                  <tr>
                    <td align="center" bgcolor="#101a2e" style="border-radius:999px;background-color:#101a2e;">
                      <a href="${escapeHtml(targetUrl)}" style="display:inline-block;padding:11px 18px;font-size:14px;line-height:1;font-weight:700;color:#ffffff;text-decoration:none;">
                        Ir para o Gimerr
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
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
      ? `O game "${body.gameName}" foi aprovado`
      : `O game "${body.gameName}" não foi aprovado`;

    const textContent = buildTextContent({
      gameName: body.gameName,
      gameId: body.gameId,
      approved: body.approved,
      appUrl: baseUrl,
    });
    const htmlContent = buildHtmlContent({
      gameName: body.gameName,
      gameId: body.gameId,
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
