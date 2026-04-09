import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";

if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

interface Payload {
  to: string;
  gameName: string;
  gameId?: string;
  listingId?: string;
  approved: boolean;
  note?: string;
  locale?: string;
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

function normalizeLocale(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.startsWith("pt") ? "pt-BR" : "en";
}

function getCopy(locale: string) {
  if (locale === "en") {
    return {
      lang: "en",
      greeting: "Hello,",
      approvedSubject: "Your game request was approved",
      rejectedSubject: "Your game request was not approved",
      approvedTitle: "Game available on Gimerr",
      rejectedTitle: "Action needed",
      approvedPublishedLead: "Your request was approved and your listing is already live.",
      approvedPublishedBody: "Your game is now available and your listing can already receive visits.",
      approvedGameLead: "Your request was approved.",
      approvedGameBody: "You can now create listings for this game.",
      approvedListingButton: "View my listing",
      approvedGameButton: "View game page",
      rejectedBody: "Please review the submitted website information.",
      supportLead: "If you have questions, contact support at",
      noteLabel: "Admin note",
      appButton: "Go to Gimerr",
      textApprovedPublished: (gameName: string) => [
        `The game "${gameName}" was approved and your listing is already live.`,
        `Your listing for "${gameName}" can already receive visits.`,
      ],
      textApprovedGame: (gameName: string) => [
        `The game "${gameName}" was approved.`,
        `You can now create listings for "${gameName}".`,
      ],
      textRejected: (gameName: string) => [
        `The game "${gameName}" was not approved.`,
        "Please review the submitted website information.",
      ],
    };
  }

  return {
    lang: "pt-BR",
    greeting: "Olá,",
    approvedSubject: "Sua solicitação de game foi aprovada",
    rejectedSubject: "Sua solicitação de game não foi aprovada",
    approvedTitle: "Game disponível no Gimerr",
    rejectedTitle: "Ajuste necessário",
    approvedPublishedLead: "Sua solicitação foi aprovada e o seu anúncio já foi publicado.",
    approvedPublishedBody: "O game já está disponível e seu anúncio já pode receber visitas.",
    approvedGameLead: "Sua solicitação foi aprovada.",
    approvedGameBody: "Você já pode criar anúncios para esse game.",
    approvedListingButton: "Ver meu anúncio",
    approvedGameButton: "Ver página do game",
    rejectedBody: "Verifique o website enviado.",
    supportLead: "Em caso de dúvida, entre em contato com o suporte em",
    noteLabel: "Observação do admin",
    appButton: "Ir para o Gimerr",
    textApprovedPublished: (gameName: string) => [
      `O game "${gameName}" foi aprovado e o seu anúncio já foi publicado.`,
      `Seu anúncio para "${gameName}" já pode receber visitas.`,
    ],
    textApprovedGame: (gameName: string) => [
      `O game "${gameName}" foi aprovado.`,
      `Você já pode criar anúncios para o game "${gameName}".`,
    ],
    textRejected: (gameName: string) => [
      `O game "${gameName}" não foi aprovado.`,
      "Verifique o website enviado.",
    ],
  };
}

function resolveTargetUrl(params: { approved: boolean; listingId?: string; gameId?: string; appUrl: string }) {
  if (params.approved && params.listingId) {
    return `${params.appUrl}/listing?id=${encodeURIComponent(params.listingId)}`;
  }
  if (params.approved && params.gameId) {
    return `${params.appUrl}/game.html?id=${encodeURIComponent(params.gameId)}`;
  }
  return params.appUrl;
}

function buildTextContent(params: {
  gameName: string;
  gameId?: string;
  listingId?: string;
  approved: boolean;
  appUrl: string;
  note?: string;
  locale: string;
}) {
  const copy = getCopy(params.locale);
  const targetUrl = resolveTargetUrl(params);
  const lines = [copy.greeting, ""];
  if (params.approved) {
    lines.push(...(params.listingId
      ? copy.textApprovedPublished(params.gameName)
      : copy.textApprovedGame(params.gameName)));
  } else {
    lines.push(...copy.textRejected(params.gameName));
  }
  if (params.note) {
    lines.push("", `${copy.noteLabel}: ${params.note}`);
  }
  lines.push("", `${copy.appButton}:`, targetUrl);
  return lines.join("\n");
}

function buildHtmlContent(params: {
  gameName: string;
  gameId?: string;
  listingId?: string;
  approved: boolean;
  note?: string;
  logoUrl: string;
  appUrl: string;
  locale: string;
}) {
  const copy = getCopy(params.locale);
  const gameName = escapeHtml(params.gameName);
  const targetUrl = resolveTargetUrl(params);
  const title = params.approved ? copy.approvedTitle : copy.rejectedTitle;
  const primaryLead = params.approved
    ? (params.listingId ? copy.approvedPublishedLead : copy.approvedGameLead)
    : copy.rejectedBody;
  const secondaryBody = params.approved
    ? (params.listingId ? copy.approvedPublishedBody : copy.approvedGameBody)
    : `${copy.supportLead} <a href="mailto:admin@gimerr.com" style="color:#76a8ff;text-decoration:none;font-weight:700;">admin@gimerr.com</a>.`;
  const buttonLabel = params.approved
    ? (params.listingId ? copy.approvedListingButton : copy.approvedGameButton)
    : copy.appButton;
  const noteHtml = params.note
    ? `
      <div style="margin:16px 0 0;padding:14px 16px;border-radius:12px;background:#f4f7ff;border:1px solid #e0e6f4;">
        <div style="margin:0 0 6px;color:#101a2e;font-size:13px;font-weight:700;">${escapeHtml(copy.noteLabel)}</div>
        <div style="margin:0;color:#516081;font-size:14px;line-height:1.6;">${escapeHtml(params.note)}</div>
      </div>
    `
    : "";

  return `
<!DOCTYPE html>
<html lang="${escapeHtml(copy.lang)}">
  <body style="margin:0;padding:0;background:#f4f7ff;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4f7ff;">
      <tr>
        <td align="center" style="padding:28px 10px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e0e6f4;border-radius:16px;overflow:hidden;">
            <tr>
              <td align="left" bgcolor="#ffffff" style="padding:26px 24px;background-color:#ffffff;">
                <img src="${escapeHtml(params.logoUrl)}" alt="Gimerr" style="display:block;height:40px;width:auto;max-width:160px;border:0;outline:none;text-decoration:none;" />
                <div style="margin-top:16px;font-size:24px;line-height:1.2;font-weight:700;color:#101a2e;">
                  ${escapeHtml(title)}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <p style="margin:0 0 12px;color:#101a2e;font-size:16px;line-height:1.7;font-weight:700;">
                  ${escapeHtml(primaryLead)}
                </p>
                <p style="margin:0 0 16px;color:#516081;font-size:14px;line-height:1.7;">
                  ${secondaryBody}
                </p>
                ${noteHtml}
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:18px;border-collapse:separate;border-spacing:0;">
                  <tr>
                    <td align="center" bgcolor="#101a2e" style="border-radius:999px;background-color:#101a2e;">
                      <a href="${escapeHtml(targetUrl)}" style="display:inline-block;padding:11px 18px;font-size:14px;line-height:1;font-weight:700;color:#ffffff;text-decoration:none;">
                        ${escapeHtml(buttonLabel)}
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
    const locale = normalizeLocale(body.locale);
    const copy = getCopy(locale);

    if (!host || !user || !pass) {
      return new Response(JSON.stringify({ ok: false, error: "Variáveis SMTP faltando" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const client = new SmtpClient();
    await client.connectTLS({ hostname: host, port, username: user, password: pass });

    const subject = body.approved ? copy.approvedSubject : copy.rejectedSubject;
    const textContent = buildTextContent({
      gameName: body.gameName,
      gameId: body.gameId,
      listingId: body.listingId,
      approved: body.approved,
      appUrl: baseUrl,
      note: body.note,
      locale,
    });
    const htmlContent = buildHtmlContent({
      gameName: body.gameName,
      gameId: body.gameId,
      listingId: body.listingId,
      approved: body.approved,
      note: body.note,
      logoUrl,
      appUrl: baseUrl,
      locale,
    });

    await client.send({
      from: user,
      to: body.to,
      subject,
      content: textContent,
      html: htmlContent,
    });

    await client.close();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  }
});
