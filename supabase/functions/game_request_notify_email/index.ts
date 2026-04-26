import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { sendGameRequestNotifyEmail } from "../_shared/game_request_notify.ts";

type Payload = {
  gameName?: string;
  website?: string;
  requestId?: string;
  userToken?: string;
  requesterEmail?: string;
  requesterName?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResponse({ ok: false, error: "PROJECT_URL ou SERVICE_ROLE_KEY ausentes" }, 500);
    }

    const body = (await req.json()) as Payload;
    const gameName = String(body.gameName || "").trim();
    const website = String(body.website || "").trim();
    const requestId = String(body.requestId || "").trim() || undefined;
    if (!gameName || !website) {
      return jsonResponse({ ok: false, error: "Payload inválido" }, 400);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const headerToken = authHeader.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "").trim()
      : "";
    const bodyToken = String(body.userToken || "").trim();
    const token = bodyToken || headerToken;
    if (!token) {
      return jsonResponse({ ok: false, error: "Não autorizado" }, 401);
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return jsonResponse({ ok: false, error: "Sessão inválida" }, 401);
    }

    const { data: profile, error: profileErr } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (profileErr) throw profileErr;
    if (!profile?.is_admin) {
      return jsonResponse({ ok: false, error: "Acesso restrito a admins" }, 403);
    }

    const requesterEmail = String(
      authData.user.email
      || body.requesterEmail
      || ""
    ).trim() || "sem-email";
    const requesterName = String(
      authData.user.user_metadata?.full_name
      || authData.user.user_metadata?.name
      || body.requesterName
      || requesterEmail.split("@")[0]
      || "Usuário"
    ).trim();

    await sendGameRequestNotifyEmail({
      requesterName,
      requesterEmail,
      gameName,
      website,
      requestId,
    });

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
