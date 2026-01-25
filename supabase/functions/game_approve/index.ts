import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  requestId?: string | number;
  approved: boolean;
  note?: string;
  skipServerInsert?: boolean;
  override?: {
    name?: string;
    website?: string;
    currency_name?: string | null;
    cover_url?: string | null;
  };
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const EMAIL_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/game_approve_email` : null;

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
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }
    const body = (await req.json()) as Payload;
    if (!body.requestId || typeof body.approved !== "boolean") {
      return errorResponse("Payload inválido");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse("Não autorizado", 401);
    }
    const token = authHeader.replace("Bearer ", "").trim();
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }
    const { data: adminData, error: adminErr } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", authData.user.id)
      .single();
    if (adminErr) throw adminErr;
    if (!adminData?.is_admin) {
      return errorResponse("Acesso restrito a admins", 403);
    }

    const { data: reqData, error: fetchErr } = await supabase
      .from("game_requests")
      .select("id,name,website,currency_name,cover_url,user_email,status,created_at")
      .eq("id", body.requestId)
      .single();
    if (fetchErr || !reqData) {
      return errorResponse("Solicitação não encontrada", 404);
    }

    if (reqData.status !== "pending" && reqData.status !== "under_review") {
      return errorResponse("Solicitação já processada", 409);
    }

    const finalName = body.override?.name?.trim() || reqData.name;
    const finalWebsite = body.override?.website?.trim() || reqData.website;
    const finalCurrency = body.override?.currency_name ?? reqData.currency_name;
    const finalCover = body.override?.cover_url ?? reqData.cover_url;

    if (body.approved && !body.skipServerInsert) {
      // Checa duplicidade de website
      const { data: dupServer, error: dupErr } = await supabase
        .from("servers")
        .select("id")
        .eq("official_site", finalWebsite)
        .limit(1);
      if (dupErr) throw dupErr;
      if (dupServer && dupServer.length > 0) {
        return errorResponse("Website já cadastrado em servers", 409);
      }

      const { error: insertErr } = await supabase.from("servers").insert({
        name: finalName,
        official_site: finalWebsite,
        banner_url: finalCover,
        currency_name: finalCurrency,
        status: "active"
      });
      if (insertErr) throw insertErr;
    }

    const { error: updateErr } = await supabase
      .from("game_requests")
      .update({
        name: finalName,
        website: finalWebsite,
        currency_name: finalCurrency,
        cover_url: finalCover,
        status: body.approved ? "approved" : "rejected",
        note: body.note || null,
      })
      .eq("id", reqData.id);
    if (updateErr) throw updateErr;

    if (reqData.user_email && EMAIL_ENDPOINT) {
      try {
        await fetch(EMAIL_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({
            to: reqData.user_email,
            gameName: finalName,
            approved: body.approved,
            note: body.note || "",
          }),
        });
      } catch (mailErr) {
        console.warn("Falha ao enviar e-mail de aprovação/recusa", mailErr);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(String(err), 500);
  }
});
