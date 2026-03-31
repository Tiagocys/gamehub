import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";

if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

type Payload = {
  to: string;
  firstName?: string | null;
  locale?: string | null;
  status?: string | null;
  targetAmount: number;
  targetCurrency: string;
  sourceAmount?: number | null;
  sourceCurrency?: string | null;
  feeAmount?: number | null;
  feeCurrency?: string | null;
  rate?: number | null;
  requestId?: string | null;
  note?: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function normalizeLocale(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized.startsWith("pt") ? "pt-BR" : "en";
}

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMoney(locale: string, currency: string, amount: number | null | undefined) {
  const safeAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  try {
    return new Intl.NumberFormat(locale === "pt-BR" ? "pt-BR" : "en-US", {
      style: "currency",
      currency: String(currency || "BRL").toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch (_err) {
    return `${safeAmount.toFixed(2)} ${String(currency || "").toUpperCase()}`.trim();
  }
}

function formatRate(locale: string, rate: number | null | undefined) {
  const safe = Number(rate);
  if (!Number.isFinite(safe) || safe <= 0) return locale === "pt-BR" ? "Não informado" : "Not provided";
  return safe.toFixed(6);
}

function getCopy(locale: string, status: string) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (locale === "en") {
    if (normalizedStatus === "cancelled") {
      return {
        lang: "en",
        subject: "Your withdrawal request was cancelled",
        title: "Your withdrawal request was cancelled",
        greeting: "Hello",
        lead: "Your withdrawal request was cancelled and the reserved balance was released back to your partner balance.",
        intro: "Below are the details of the cancelled request:",
        targetLabel: "Estimated net amount",
        sourceLabel: "Gross amount reserved",
        feeLabel: "Estimated fee",
        rateLabel: "Estimated exchange rate",
        requestLabel: "Request ID",
        footer: "If needed, review your receiving details and submit a new withdrawal request later.",
        tipsTitle: "",
        tips: [],
      };
    }
    if (normalizedStatus === "paid") {
      return {
        lang: "en",
        subject: "Your withdrawal has been sent",
        title: "Your withdrawal has been sent",
        greeting: "Hello",
        lead: "Your withdrawal was processed and sent to your registered receiving account.",
        intro: "Below are the final amounts used for this payout:",
        targetLabel: "Amount sent",
        sourceLabel: "Gross amount reserved",
        feeLabel: "Applied fee",
        rateLabel: "Applied exchange rate",
        requestLabel: "Request ID",
        footer: "If you don't recognize the receiving details, update your payout account before requesting a new withdrawal.",
        tipsTitle: "",
        tips: [],
      };
    }
    if (["rejected", "failed"].includes(normalizedStatus)) {
      return {
        lang: "en",
        subject: "Your withdrawal request was rejected",
        title: "Your withdrawal request was rejected",
        greeting: "Hello",
        lead: "Your withdrawal request could not be completed with the currently registered receiving details.",
        intro: "Below are the details of the rejected request:",
        targetLabel: "Requested net amount",
        sourceLabel: "Gross amount reserved",
        feeLabel: "Estimated fee",
        rateLabel: "Estimated exchange rate",
        requestLabel: "Request ID",
        footer: "After updating your receiving account or Pix key, you can submit a new withdrawal request.",
        tipsTitle: "Recommended next steps:",
        tips: [
          "Register a new bank account or Pix key with truthful and complete information.",
          "Review the account holder name, country, currency, and receiving details before saving again.",
          "Request a new withdrawal only after confirming the registered data is correct.",
        ],
      };
    }
    return {
      lang: "en",
      subject: "Your withdrawal request was approved",
      title: "Your withdrawal request was approved",
      greeting: "Hello",
      lead: "Your withdrawal request is no longer pending and has moved into processing.",
      intro: "Below are the amounts and conversion details used for this transfer:",
      targetLabel: "Estimated amount you will receive",
      sourceLabel: "Gross amount reserved",
      feeLabel: "Transfer fee",
      rateLabel: "Exchange rate",
      requestLabel: "Request ID",
      footer: "You can monitor the transfer status in your payout provider panel.",
      tipsTitle: "",
      tips: [],
    };
  }
  if (normalizedStatus === "cancelled") {
    return {
      lang: "pt-BR",
      subject: "Sua solicitação de saque foi cancelada",
      title: "Sua solicitação de saque foi cancelada",
      greeting: "Olá",
      lead: "Sua solicitação de saque foi cancelada e o valor reservado voltou para o seu saldo de parceiro.",
      intro: "Abaixo estão os detalhes do pedido cancelado:",
      targetLabel: "Valor líquido estimado",
      sourceLabel: "Valor bruto reservado",
      feeLabel: "Taxa estimada",
      rateLabel: "Câmbio estimado",
      requestLabel: "ID da solicitação",
      footer: "Revise seus dados bancários e solicite um novo saque.",
      tipsTitle: "",
      tips: [],
    };
  }
  if (normalizedStatus === "paid") {
    return {
      lang: "pt-BR",
      subject: "Seu saque foi enviado",
      title: "Seu saque foi enviado",
      greeting: "Olá",
      lead: "Seu saque foi processado e enviado para a conta de recebimento cadastrada.",
      intro: "Abaixo estão os valores finais usados neste pagamento:",
      targetLabel: "Valor enviado",
      sourceLabel: "Valor bruto reservado",
      feeLabel: "Taxa aplicada",
      rateLabel: "Câmbio aplicado",
      requestLabel: "ID da solicitação",
      footer: "Se você não reconhecer os dados de recebimento, atualize a conta antes de solicitar um novo saque.",
      tipsTitle: "",
      tips: [],
    };
  }
  if (["rejected", "failed"].includes(normalizedStatus)) {
    return {
      lang: "pt-BR",
      subject: "Sua solicitação de saque foi rejeitada",
      title: "Sua solicitação de saque foi rejeitada",
      greeting: "Olá",
      lead: "Sua solicitação de saque não pôde ser concluída com os dados de recebimento cadastrados no momento.",
      intro: "Abaixo estão os detalhes do pedido rejeitado:",
      targetLabel: "Valor líquido solicitado",
      sourceLabel: "Valor bruto reservado",
      feeLabel: "Taxa estimada",
      rateLabel: "Câmbio estimado",
      requestLabel: "ID da solicitação",
      footer: "Depois de atualizar sua conta ou chave Pix, você pode enviar uma nova solicitação de saque.",
      tipsTitle: "Próximos passos recomendados:",
      tips: [
        "Cadastre novamente uma conta bancária ou chave Pix com todas as informações verdadeiras.",
        "Revise o nome do titular, país, moeda e dados de recebimento antes de salvar novamente.",
        "Solicite um novo saque somente após confirmar que os dados cadastrados estão corretos.",
      ],
    };
  }
  return {
    lang: "pt-BR",
    subject: "Sua solicitação de saque foi aprovada",
    title: "Sua solicitação de saque foi aprovada",
    greeting: "Olá",
    lead: "Sua solicitação de saque deixou o estado pendente e entrou em processamento.",
    intro: "Abaixo estão os valores e os detalhes de conversão usados nesta transferência:",
    targetLabel: "Valor líquido estimado a receber",
    sourceLabel: "Valor bruto reservado",
    feeLabel: "Taxa de transferência",
    rateLabel: "Câmbio aplicado",
    requestLabel: "ID da solicitação",
    footer: "Você pode acompanhar o status da transferência no painel do seu provedor de saque.",
    tipsTitle: "",
    tips: [],
  };
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const body = (await req.json()) as Payload;
    if (!body.to || !body.targetCurrency || !Number.isFinite(Number(body.targetAmount))) {
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
    const status = String(body.status || "approved").trim().toLowerCase();
    const copy = getCopy(locale, status);

    if (!host || !user || !pass) {
      return new Response(JSON.stringify({ ok: false, error: "Variáveis SMTP faltando" }), {
        status: 500,
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const name = String(body.firstName || "").trim();
    const greeting = `${copy.greeting}${name ? ` ${name}` : ""},`;
    const targetAmount = formatMoney(locale, body.targetCurrency, body.targetAmount);
    const sourceAmount = body.sourceCurrency
      ? formatMoney(locale, body.sourceCurrency, body.sourceAmount || 0)
      : (locale === "pt-BR" ? "Não informado" : "Not provided");
    const feeAmount = body.feeCurrency
      ? formatMoney(locale, body.feeCurrency, body.feeAmount || 0)
      : (locale === "pt-BR" ? "Não informado" : "Not provided");
    const rate = formatRate(locale, body.rate);
    const requestId = String(body.requestId || "").trim();
    const note = String(body.note || "").trim();

    const lines = [
      greeting,
      "",
      copy.lead,
      copy.intro,
      "",
      `${copy.targetLabel}: ${targetAmount}`,
      `${copy.sourceLabel}: ${sourceAmount}`,
      `${copy.feeLabel}: ${feeAmount}`,
      `${copy.rateLabel}: ${rate}`,
      ...(requestId ? [`${copy.requestLabel}: ${requestId}`] : []),
      ...(note ? ["", note] : []),
      ...(copy.tipsTitle ? ["", copy.tipsTitle] : []),
      ...copy.tips.map((tip) => `- ${tip}`),
      "",
      copy.footer,
    ];

    const html = `
<!DOCTYPE html>
<html lang="${escapeHtml(copy.lang)}">
  <body style="margin:0;padding:0;background:#f4f7ff;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f4f7ff;">
      <tr>
        <td align="center" style="padding:28px 10px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e0e6f4;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:24px;">
                <img src="${escapeHtml(logoUrl)}" alt="Gimerr" style="display:block;height:40px;width:auto;max-width:160px;border:0;" />
                <div style="margin-top:16px;font-size:24px;line-height:1.2;font-weight:700;color:#101a2e;">${escapeHtml(copy.title)}</div>
                <p style="margin:18px 0 10px;color:#101a2e;font-size:15px;line-height:1.7;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 10px;color:#516081;font-size:14px;line-height:1.7;">${escapeHtml(copy.lead)}</p>
                <p style="margin:0 0 16px;color:#516081;font-size:14px;line-height:1.7;">${escapeHtml(copy.intro)}</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;border:1px solid #e0e6f4;border-radius:12px;overflow:hidden;">
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #e0e6f4;font-weight:700;color:#101a2e;">${escapeHtml(copy.targetLabel)}:</td>
                    <td align="right" style="padding:12px 14px;border-bottom:1px solid #e0e6f4;color:#101a2e;">${escapeHtml(targetAmount)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #e0e6f4;font-weight:700;color:#101a2e;">${escapeHtml(copy.sourceLabel)}:</td>
                    <td align="right" style="padding:12px 14px;border-bottom:1px solid #e0e6f4;color:#101a2e;">${escapeHtml(sourceAmount)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #e0e6f4;font-weight:700;color:#101a2e;">${escapeHtml(copy.feeLabel)}:</td>
                    <td align="right" style="padding:12px 14px;border-bottom:1px solid #e0e6f4;color:#101a2e;">${escapeHtml(feeAmount)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;${requestId ? "border-bottom:1px solid #e0e6f4;" : ""}font-weight:700;color:#101a2e;">${escapeHtml(copy.rateLabel)}:</td>
                    <td align="right" style="padding:12px 14px;${requestId ? "border-bottom:1px solid #e0e6f4;" : ""}color:#101a2e;">${escapeHtml(rate)}</td>
                  </tr>
                  ${requestId ? `
                  <tr>
                    <td style="padding:12px 14px;font-weight:700;color:#101a2e;">${escapeHtml(copy.requestLabel)}:</td>
                    <td align="right" style="padding:12px 14px;color:#101a2e;">${escapeHtml(requestId)}</td>
                  </tr>
                  ` : ""}
                </table>
                ${note ? `<p style="margin:16px 0 0;color:#516081;font-size:13px;line-height:1.7;">${escapeHtml(note)}</p>` : ""}
                ${copy.tips.length > 0 ? `
                  <div style="margin-top:16px;border:1px solid #e0e6f4;border-radius:12px;padding:14px;">
                    <strong style="display:block;margin-bottom:8px;color:#101a2e;">${escapeHtml(copy.tipsTitle)}</strong>
                    <ul style="margin:0;padding-left:18px;color:#516081;font-size:13px;line-height:1.7;">
                      ${copy.tips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}
                    </ul>
                  </div>
                ` : ""}
                <p style="margin:16px 0 0;color:#516081;font-size:13px;line-height:1.7;">${escapeHtml(copy.footer)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `.trim();

    const client = new SmtpClient();
    await client.connectTLS({ hostname: host, port, username: user, password: pass });
    await client.send({
      from: user,
      to: body.to,
      subject: copy.subject,
      content: lines.join("\n"),
      html,
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
