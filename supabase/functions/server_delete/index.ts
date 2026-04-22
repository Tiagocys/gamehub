import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { deleteLogoFromR2, extractLogoR2Key, extractSupabaseLogoPath } from "../_shared/r2_logo.ts";

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
      .select("id,name,banner_url")
      .eq("id", serverId)
      .maybeSingle();
    if (serverErr) throw serverErr;
    if (!server) {
      return errorResponse("Servidor não encontrado", 404);
    }

    const logoR2Key = extractLogoR2Key(server.banner_url);
    const logoSupabasePath = extractSupabaseLogoPath(server.banner_url);
    const { error: deleteErr } = await supabase
      .from("servers")
      .delete()
      .eq("id", serverId);
    if (deleteErr) throw deleteErr;

    let logoDeleted = false;
    if (logoR2Key || logoSupabasePath) {
      if (logoR2Key) {
        try {
          await deleteLogoFromR2(logoR2Key);
          logoDeleted = true;
        } catch (storageErr) {
          console.error("Falha ao excluir logo do servidor no R2:", storageErr);
        }
      } else if (logoSupabasePath) {
        const { error: storageErr } = await supabase.storage
          .from("server_logos")
          .remove([logoSupabasePath]);
        if (storageErr) {
          console.error("Falha ao excluir logo do servidor no Supabase Storage:", storageErr);
        } else {
          logoDeleted = true;
        }
      }
    }

    return jsonResponse({
      ok: true,
      deletedServer: {
        id: server.id,
        name: server.name,
      },
      logoDeleted,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao excluir servidor", 500);
  }
});
