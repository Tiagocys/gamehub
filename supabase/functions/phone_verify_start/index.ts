import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  userToken?: string;
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

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "GMR-";
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (let i = 0; i < bytes.length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
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
    const token =
      payload.userToken?.trim() ||
      (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) {
      return errorResponse("Não autorizado", 401);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    await supabase
      .from("phone_verifications")
      .update({ status: "expired" })
      .eq("user_id", authData.user.id)
      .in("status", ["pending", "code_confirmed"]);

    let code = "";
    let inserted = false;
    let attempts = 0;
    while (!inserted && attempts < 5) {
      attempts += 1;
      code = generateCode();
      const { error } = await supabase.from("phone_verifications").insert({
        user_id: authData.user.id,
        code,
        status: "pending",
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      if (!error) {
        inserted = true;
      } else if (error.code === "23502") {
        return errorResponse("Atualize a migration: phone_verifications.phone deve permitir NULL.", 500);
      } else if (error.code !== "23505") {
        throw error;
      }
    }
    if (!inserted) {
      return errorResponse("Não foi possível gerar o código. Tente novamente.");
    }

    const link = `https://t.me/gimerrbot?start=verify_${code}`;
    return new Response(
      JSON.stringify({
        ok: true,
        code,
        link,
        expiresIn: 600,
      }),
      { headers: { "content-type": "application/json", ...corsHeaders } }
    );
  } catch (err) {
    console.error(err);
    return errorResponse("Erro ao iniciar verificação", 500);
  }
});
