import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

type Payload = {
  gameName?: string;
  website?: string;
  requestId?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const ADMIN_EMAIL = "admin@gimerr.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

function buildTextContent(params: {
  requesterName: string;
  requesterEmail: string;
  gameName: string;
  website: string;
  requestId?: string;
  appUrl: string;
}) {
  const lines = [
    "Nova solicitação de game recebida.",
    "",
    `Usuário: ${params.requesterName}`,
    `E-mail: ${params.requesterEmail}`,
    `Game: ${params.gameName}`,
    `Website: ${params.website}`,
  ];
  if (params.requestId) {
    lines.push(`Request ID: ${params.requestId}`);
  }
  lines.push("", `Abrir painel admin: ${params.appUrl}/admin.html`);
  return lines.join("\n");
}

function buildHtmlContent(params: {
  requesterName: string;
  requesterEmail: string;
  gameName: string;
  website: string;
  requestId?: string;
  logoUrl: string;
  appUrl: string;
}) {
  const requestIdRow = params.requestId
    ? `
      <tr>
        <td style="padding:8px 0;color:#516081;font-size:14px;font-weight:700;">Request ID</td>
        <td style="padding:8px 0;color:#101a2e;font-size:14px;">${escapeHtml(params.requestId)}</td>
      </tr>
    `
    : "";

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
                  Nova solicitação de game
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <p style="margin:0 0 16px;color:#516081;font-size:14px;line-height:1.7;">
                  Um usuário enviou uma nova solicitação de cadastro de game e pode precisar de análise.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding:8px 0;color:#516081;font-size:14px;font-weight:700;">Usuário</td>
                    <td style="padding:8px 0;color:#101a2e;font-size:14px;">${escapeHtml(params.requesterName)}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#516081;font-size:14px;font-weight:700;">E-mail</td>
                    <td style="padding:8px 0;color:#101a2e;font-size:14px;">${escapeHtml(params.requesterEmail)}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#516081;font-size:14px;font-weight:700;">Game</td>
                    <td style="padding:8px 0;color:#101a2e;font-size:14px;">${escapeHtml(params.gameName)}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#516081;font-size:14px;font-weight:700;">Website</td>
                    <td style="padding:8px 0;color:#101a2e;font-size:14px;">${escapeHtml(params.website)}</td>
                  </tr>
                  ${requestIdRow}
                </table>
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:18px;border-collapse:separate;border-spacing:0;">
                  <tr>
                    <td align="center" bgcolor="#101a2e" style="border-radius:999px;background-color:#101a2e;">
                      <a href="${escapeHtml(params.appUrl)}/admin.html" style="display:inline-block;padding:11px 18px;font-size:14px;line-height:1;font-weight:700;color:#ffffff;text-decoration:none;">
                        Abrir painel admin
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

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResponse({ ok: false, error: "PROJECT_URL ou SERVICE_ROLE_KEY ausentes" }, 500);
    }

    const body = (await req.json()) as Payload;
    const gameName = String(body.gameName || "").trim();
    const website = String(body.website || "").trim();
    const requestId = String(body.requestId || "").trim() || undefined;
    if (!gameName || !website) {
      return jsonResponse({ ok: false, error: "Payload inválido" }, 400);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ ok: false, error: "Não autorizado" }, 401);
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return jsonResponse({ ok: false, error: "Sessão inválida" }, 401);
    }

    const requesterEmail = String(authData.user.email || "").trim() || "sem-email";
    const requesterName = String(
      authData.user.user_metadata?.full_name
      || authData.user.user_metadata?.name
      || requesterEmail.split("@")[0]
      || "Usuário"
    ).trim();

    const host = Deno.env.get("SMTP_HOST");
    const port = Number(Deno.env.get("SMTP_PORT") || "465");
    const user = Deno.env.get("SMTP_USER");
    const pass = Deno.env.get("SMTP_PASS");
    const baseUrlRaw = Deno.env.get("EMAIL_ASSET_BASE_URL") || "http://localhost:8788";
    const baseUrl = baseUrlRaw.replace(/\/+$/, "");
    const logoUrl = `${baseUrl}/img/logo.png`;

    if (!host || !user || !pass) {
      return jsonResponse({ ok: false, error: "Variáveis SMTP faltando" }, 500);
    }

    const client = new SmtpClient();
    await client.connectTLS({ hostname: host, port, username: user, password: pass });
    await client.send({
      from: user,
      to: ADMIN_EMAIL,
      subject: `Nova solicitação de game: ${gameName}`,
      content: buildTextContent({
        requesterName,
        requesterEmail,
        gameName,
        website,
        requestId,
        appUrl: baseUrl,
      }),
      html: buildHtmlContent({
        requesterName,
        requesterEmail,
        gameName,
        website,
        requestId,
        logoUrl,
        appUrl: baseUrl,
      }),
    });
    await client.close();

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
