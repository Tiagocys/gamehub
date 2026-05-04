import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { enforceUserRateLimit, RateLimitError } from "../_shared/rate_limit.ts";

type Payload = {
  username?: string;
  displayName?: string;
  aboutMe?: string | null;
  avatarUrl?: string | null;
  discordUsername?: string | null;
  discordId?: string | null;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

const PROFILE_USERNAME_REGEX = /^[a-z0-9]{3,20}$/;
const DISPLAY_NAME_REGEX = /^.{1,32}$/u;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function normalizeProfileUsername(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
}

function normalizeDiscordUsername(value: string | null | undefined) {
  let normalized = String(value || "").trim().toLowerCase();
  normalized = normalized.replace(/^@+/, "");
  normalized = normalized.replace(/#\d{1,4}$/, "");
  normalized = normalized.replace(/[^a-z0-9._]/g, "");
  normalized = normalized.replace(/\.{2,}/g, ".");
  return normalized.slice(0, 32) || null;
}

function normalizeNullableText(value: string | null | undefined, maxLength: number) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function normalizeAvatarUrl(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch (_err) {
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse("Não autorizado", 401);
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return errorResponse("Não autorizado", 401);
    }

    const payload = (await req.json()) as Payload;
    const username = normalizeProfileUsername(String(payload?.username || ""));
    const displayName = String(payload?.displayName || "").trim();
    const aboutMe = normalizeNullableText(payload?.aboutMe, 1000);
    const avatarUrl = payload?.avatarUrl === null ? null : normalizeAvatarUrl(payload?.avatarUrl);
    const discordUsername = normalizeDiscordUsername(payload?.discordUsername);
    const discordIdRaw = String(payload?.discordId || "").trim();
    const discordId = /^[0-9]{17,20}$/.test(discordIdRaw) ? discordIdRaw : null;

    if (!DISPLAY_NAME_REGEX.test(displayName)) {
      return errorResponse("Informe um nome de exibição entre 1 e 32 caracteres.", 400);
    }
    if (!PROFILE_USERNAME_REGEX.test(username)) {
      return errorResponse("Corrija o username antes de salvar.", 400);
    }
    if (payload?.avatarUrl && !avatarUrl) {
      return errorResponse("URL do avatar inválida.", 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    await enforceUserRateLimit(supabase, authData.user.id, "profile_update", {
      maxCount: 10,
      windowSeconds: 15 * 60,
      bucketSeconds: 60,
      message: "Muitas tentativas de salvar o perfil. Aguarde alguns minutos e tente novamente.",
    });

    const { data: existing, error: existingErr } = await supabase
      .from("users")
      .select("id,status,phone,phone_verified,phone_verified_at,whatsapp_same_phone,show_whatsapp_button,show_telegram_button")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (existingErr && existingErr.code !== "PGRST116") throw existingErr;

    const upsertPayload = {
      id: authData.user.id,
      username,
      email: authData.user.email || null,
      status: existing?.status || "active",
      first_name: displayName,
      last_name: null,
      discord_username: discordUsername,
      discord_id: discordId,
      about_me: aboutMe,
      avatar_url: avatarUrl,
      phone: existing?.phone ?? null,
      phone_verified: existing?.phone_verified ?? false,
      phone_verified_at: existing?.phone_verified_at ?? null,
      whatsapp_same_phone: existing?.whatsapp_same_phone ?? false,
      show_whatsapp_button: existing?.show_whatsapp_button ?? false,
      show_telegram_button: existing?.show_telegram_button ?? false,
    };

    const { data: savedProfile, error: saveErr } = await supabase
      .from("users")
      .upsert(upsertPayload, { onConflict: "id" })
      .select("id,username,email,status,first_name,last_name,discord_username,discord_id,about_me,avatar_url,phone,phone_verified,phone_verified_at,whatsapp_same_phone,show_whatsapp_button,show_telegram_button")
      .single();
    if (saveErr) {
      if (saveErr.code === "23505") {
        return errorResponse("Este username já está em uso.", 409);
      }
      throw saveErr;
    }

    return jsonResponse({
      ok: true,
      profile: savedProfile,
    });
  } catch (err) {
    console.error(err);
    if (err instanceof RateLimitError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponse(err instanceof Error ? err.message : "Erro ao salvar perfil.", 500);
  }
});
