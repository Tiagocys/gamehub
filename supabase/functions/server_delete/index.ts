import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  serverId?: string;
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

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const payload = (await req.json()) as Payload;
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = String(payload?.userToken || "").trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) {
      return errorResponse("Não autorizado", 401);
    }
    const serverId = String(payload?.serverId || "").trim();
    if (!serverId) {
      return errorResponse("serverId é obrigatório", 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    const userId = authData.user.id;
    const { data: profile, error: profileErr } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr) throw profileErr;
    if (!profile?.is_admin) {
      return errorResponse("Apenas administradores podem excluir servidores", 403);
    }

    const { data: server, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,website_domain,status")
      .eq("id", serverId)
      .maybeSingle();
    if (serverErr) throw serverErr;
    if (!server) {
      return errorResponse("Servidor não encontrado", 404);
    }
    if (String(server.status || "") === "deleted") {
      return jsonResponse({
        ok: true,
        deletedServer: {
          id: server.id,
          name: server.name,
        },
        alreadyDeleted: true,
      });
    }

    const { error: updateServerErr } = await supabase
      .from("servers")
      .update({ status: "deleted" })
      .eq("id", serverId);
    if (updateServerErr) throw updateServerErr;

    const { error: listingsErr } = await supabase
      .from("listings")
      .update({
        status: "removed",
        highlight_status: "none",
        highlight_started_at: null,
        highlight_expires_at: null,
      })
      .eq("server_id", serverId);
    if (listingsErr) throw listingsErr;

    if (String(server.website_domain || "").trim()) {
      const { error: requestErr } = await supabase
        .from("game_requests")
        .update({ status: "deleted" })
        .eq("website_domain", server.website_domain)
        .eq("status", "approved");
      if (requestErr) throw requestErr;
    }

    return jsonResponse({
      ok: true,
      deletedServer: {
        id: server.id,
        name: server.name,
      },
      archived: true,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao excluir servidor", 500);
  }
});
