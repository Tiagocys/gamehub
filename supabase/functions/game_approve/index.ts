import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  requestId?: string | number;
  approved: boolean;
  note?: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis SUPABASE_URL/SERVICE_ROLE ausentes", 500);
    }
    const body = (await req.json()) as Payload;
    if (!body.requestId || typeof body.approved !== "boolean") {
      return errorResponse("Payload inválido");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: reqData, error: fetchErr } = await supabase
      .from("game_requests")
      .select("id,name,website,description,cover_url,user_email,status,created_at")
      .eq("id", body.requestId)
      .single();
    if (fetchErr || !reqData) {
      return errorResponse("Solicitação não encontrada", 404);
    }

    if (reqData.status !== "pending" && reqData.status !== "under_review") {
      return errorResponse("Solicitação já processada", 409);
    }

    if (body.approved) {
      // Checa duplicidade de website
      const { data: dupServer, error: dupErr } = await supabase
        .from("servers")
        .select("id")
        .eq("official_site", reqData.website)
        .limit(1);
      if (dupErr) throw dupErr;
      if (dupServer && dupServer.length > 0) {
        return errorResponse("Website já cadastrado em servers", 409);
      }

      const { error: insertErr } = await supabase.from("servers").insert({
        name: reqData.name,
        official_site: reqData.website,
        banner_url: reqData.cover_url,
        description: reqData.description,
        status: "active"
      });
      if (insertErr) throw insertErr;
    }

    const { error: updateErr } = await supabase
      .from("game_requests")
      .update({
        status: body.approved ? "approved" : "rejected",
        note: body.note || null,
      })
      .eq("id", reqData.id);
    if (updateErr) throw updateErr;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(String(err), 500);
  }
});
