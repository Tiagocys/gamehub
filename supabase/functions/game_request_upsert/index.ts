import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { sendGameRequestNotifyEmail } from "../_shared/game_request_notify.ts";
import { enforceUserRateLimit, RateLimitError } from "../_shared/rate_limit.ts";

type Payload = {
  name?: string;
  website?: string;
  discord_invite?: string | null;
  is_owner?: boolean;
  cover_url?: string | null;
  userToken?: string;
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
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function ensureHttpsPrefix(raw: string) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const withoutWww = withoutProtocol.replace(/^www\./i, "");
  return `https://${withoutWww}`;
}

function normalizeWebsite(raw: string) {
  const withProtocol = ensureHttpsPrefix(raw);
  if (!withProtocol) return null;
  try {
    const url = new URL(withProtocol);
    url.protocol = "https:";
    url.hash = "";
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}${url.search || ""}`;
  } catch (_err) {
    return null;
  }
}

function extractDomainKey(raw: string) {
  try {
    const url = new URL(ensureHttpsPrefix(raw));
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch (_err) {
    return null;
  }
}

function normalizeOptionalUrl(raw: string | null | undefined) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    const withProtocol = ensureHttpsPrefix(trimmed);
    const url = new URL(withProtocol);
    if (url.hostname.toLowerCase() !== "discord.gg") return null;
    if (!url.pathname || url.pathname === "/") return null;
    url.protocol = "https:";
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch (_err) {
    return null;
  }
}

function isMissingDiscordInviteColumnError(err: { message?: string } | null | undefined) {
  return Boolean(err && String(err.message || "").includes("discord_invite"));
}

function isMissingOwnerColumnError(err: { message?: string } | null | undefined) {
  return Boolean(err && String(err.message || "").includes("is_owner"));
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
    if (!token) return errorResponse("Não autorizado", 401);

    const name = String(payload.name || "").trim();
    const website = normalizeWebsite(String(payload.website || ""));
    const websiteDomain = extractDomainKey(website || String(payload.website || ""));
    const discordInvite = payload.discord_invite ? normalizeOptionalUrl(payload.discord_invite) : null;
    const coverUrl = String(payload.cover_url || "").trim() || null;
    const isOwner = Boolean(payload.is_owner);

    if (!name || !website || !websiteDomain) {
      return errorResponse("Payload inválido", 400);
    }
    if (payload.discord_invite && !discordInvite) {
      return errorResponse("Convite do Discord inválido.", 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    await enforceUserRateLimit(supabase, authData.user.id, "game_request_upsert", {
      maxCount: 6,
      windowSeconds: 60 * 60,
      bucketSeconds: 60,
      message: "Muitas tentativas de cadastro de game. Aguarde alguns minutos e tente novamente.",
    });

    const { data: existingServer, error: serverErr } = await supabase
      .from("servers")
      .select("id,status")
      .eq("website_domain", websiteDomain)
      .neq("status", "deleted")
      .limit(1)
      .maybeSingle();
    if (serverErr) throw serverErr;
    if (existingServer?.id) {
      return errorResponse("Este jogo já está cadastrado ou em análise.", 409);
    }

    const { data: existingRequest, error: requestErr } = await supabase
      .from("game_requests")
      .select("id,status,cover_url")
      .eq("website_domain", websiteDomain)
      .limit(1)
      .maybeSingle();
    if (requestErr) throw requestErr;

    const existingStatus = String(existingRequest?.status || "").toLowerCase();
    if (["pending", "under_review", "approved"].includes(existingStatus)) {
      return errorResponse("Este jogo já está cadastrado ou em análise.", 409);
    }

    const requestPayload: Record<string, unknown> = {
      id: existingRequest?.id || undefined,
      name,
      website,
      discord_invite: discordInvite,
      is_owner: isOwner,
      cover_url: coverUrl,
      status: "pending",
      user_id: authData.user.id,
      user_email: authData.user.email || null,
    };

    let data = null;
    let error = null;
    ({ data, error } = await supabase
      .from("game_requests")
      .upsert(requestPayload, { onConflict: "website" })
      .select("id,status,cover_url")
      .single());

    if (isMissingDiscordInviteColumnError(error) && isMissingOwnerColumnError(error)) {
      const { discord_invite: _discord, is_owner: _owner, ...fallbackPayload } = requestPayload;
      ({ data, error } = await supabase
        .from("game_requests")
        .upsert(fallbackPayload, { onConflict: "website" })
        .select("id,status,cover_url")
        .single());
    } else if (isMissingDiscordInviteColumnError(error)) {
      const { discord_invite: _discord, ...fallbackPayload } = requestPayload;
      ({ data, error } = await supabase
        .from("game_requests")
        .upsert(fallbackPayload, { onConflict: "website" })
        .select("id,status,cover_url")
        .single());
    } else if (isMissingOwnerColumnError(error)) {
      const { is_owner: _owner, ...fallbackPayload } = requestPayload;
      ({ data, error } = await supabase
        .from("game_requests")
        .upsert(fallbackPayload, { onConflict: "website" })
        .select("id,status,cover_url")
        .single());
    }
    if (error) throw error;

    const shouldNotifyAdmin = !existingRequest?.id || ["deleted", "rejected"].includes(existingStatus);
    if (shouldNotifyAdmin) {
      try {
        const requesterEmail = String(authData.user.email || "").trim() || "sem-email";
        const requesterName = String(
          authData.user.user_metadata?.full_name
          || authData.user.user_metadata?.name
          || requesterEmail.split("@")[0]
          || "Usuário"
        ).trim();
        await sendGameRequestNotifyEmail({
          requesterName,
          requesterEmail,
          gameName: name,
          website,
          requestId: String(data?.id || existingRequest?.id || "").trim() || undefined,
        });
      } catch (notifyErr) {
        console.warn("Failed to notify admin about the new game request.", notifyErr);
      }
    }

    return jsonResponse({
      ok: true,
      requestId: data?.id || existingRequest?.id || null,
      previousCoverUrl: String(existingRequest?.cover_url || "").trim() || null,
      shouldNotifyAdmin,
      reopened: Boolean(existingRequest?.id),
    });
  } catch (err) {
    console.error(err);
    if (err instanceof RateLimitError) {
      return errorResponse(err.message, err.status);
    }
    return errorResponse(err instanceof Error ? err.message : "Erro ao salvar solicitação de game", 500);
  }
});
