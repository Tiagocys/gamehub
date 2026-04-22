import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { deleteLogoFromR2, extractLogoR2Key, extractSupabaseLogoPath, getLogoR2Config } from "../_shared/r2_logo.ts";

type Payload = {
  logoUrl?: string;
  key?: string;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const { prefix: R2_LOGO_PREFIX } = getLogoR2Config();

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

    const rawInput = payload.logoUrl || payload.key;
    const r2Key = extractLogoR2Key(rawInput);
    const supabasePath = extractSupabaseLogoPath(rawInput);
    const storagePath = r2Key || supabasePath;
    if (!storagePath) {
      return errorResponse("Logo inválida", 400);
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

    const isAdmin = Boolean(profile?.is_admin);
    const ownedByUser = storagePath.startsWith(`${R2_LOGO_PREFIX}/${userId}/`) || storagePath.startsWith(`${userId}/`);
    if (!isAdmin && !ownedByUser) {
      return errorResponse("Sem permissão para excluir esta logo", 403);
    }

    if (r2Key) {
      await deleteLogoFromR2(r2Key);
    } else {
      const { error: removeErr } = await supabase.storage
        .from("server_logos")
        .remove([supabasePath!]);
      if (removeErr) throw removeErr;
    }

    return jsonResponse({
      ok: true,
      deletedPath: storagePath,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao excluir logo", 500);
  }
});
