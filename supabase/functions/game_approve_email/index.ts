// supabase edge function: envia email ao usuário após aprovação/recusa de game
// Use supabase functions deploy index

import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";

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

    const lines = body.approved
      ? [
          `Olá,`,
          "",
          `O game ${body.gameName} foi aprovado e já pode aparecer no marketplace da comunidade.`,
          "Se você tiver assets adicionais, responda este e-mail com as URLs atualizadas.",
          "",
          "Obrigado por colaborar com a comunidade Gimerr!",
        ]
      : [
          `Olá,`,
          "",
          `Sua solicitação para o game ${body.gameName} foi recusada.`,
          body.note ? `Motivo: ${body.note}` : "Motivo: não informado.",
          "Você pode reenviar corrigindo as informações e o website.",
        ];

    await client.send({
      from: user,
      to: body.to,
      subject,
      content: lines.join("\n"),
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
