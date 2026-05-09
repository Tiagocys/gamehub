import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { announceListingToDiscord } from "../_shared/discord_bot.ts";

type Payload = {
  userToken?: string;
  listingId?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (!SUPABASE_URL || !SERVICE_KEY) return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);

    const body = (await req.json().catch(() => ({}))) as Payload;
    const token = String(body.userToken || "").trim();
    const listingId = String(body.listingId || "").trim();
    if (!token || !listingId) return errorResponse("Payload inválido", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const { data: listingRow, error: listingErr } = await supabase
      .from("listings")
      .select("id,user_id,status")
      .eq("id", listingId)
      .maybeSingle();
    if (listingErr) throw listingErr;
    if (!listingRow?.id) return errorResponse("Anúncio não encontrado", 404);
    if (String(listingRow.user_id || "") !== String(authData.user.id || "")) {
      return errorResponse("Você só pode anunciar seus próprios anúncios no Discord.", 403);
    }
    if (String(listingRow.status || "") !== "active") {
      return errorResponse("Apenas anúncios ativos podem ser enviados ao Discord.", 409);
    }

    const result = await announceListingToDiscord({ supabase, listingId });
    return new Response(JSON.stringify({
      ...result,
      ok: true,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
