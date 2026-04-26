import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  serverId?: string;
  action?: "activate" | "deactivate";
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

function isMissingFeedHighlightColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return err.code === "42703" || String(err.message || "").includes("feed_highlight_status");
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
    const action = payload.action === "deactivate" ? "deactivate" : "activate";
    const serverId = String(payload.serverId || "").trim();
    if (!serverId) {
      return errorResponse("serverId é obrigatório", 400);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado", 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const userId = authData.user.id;
    const nowIso = new Date().toISOString();

    const { data: server, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,status,owner_id,feed_highlight_status,feed_highlight_started_at")
      .eq("id", serverId)
      .maybeSingle();

    if (isMissingFeedHighlightColumnError(serverErr)) {
      return errorResponse("As colunas do destaque de servidor ainda não existem. Aplique as migrations mais recentes.", 409);
    }
    if (serverErr) throw serverErr;
    if (!server) return errorResponse("Servidor não encontrado", 404);

    if (String(server.owner_id || "") !== userId) {
      return errorResponse("Apenas o owner do servidor pode gerenciar este destaque.", 403);
    }
    if (String(server.status || "") !== "active") {
      return errorResponse("Apenas servidores ativos podem ser impulsionados.", 409);
    }

    const nextStatus = action === "activate" ? "active" : "none";
    const nextStartedAt = action === "activate" ? nowIso : null;

    const { data: updatedServer, error: updateErr } = await supabase
      .from("servers")
      .update({
        feed_highlight_status: nextStatus,
        feed_highlight_started_at: nextStartedAt,
      })
      .eq("id", serverId)
      .select("id,name,status,owner_id,admin_beneficiary_id,feed_highlight_status,feed_highlight_started_at")
      .single();

    if (updateErr) throw updateErr;

    return jsonResponse({
      ok: true,
      action,
      server: updatedServer,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao atualizar o destaque do servidor", 500);
  }
});
