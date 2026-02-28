import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  serverId?: string;
  name?: string;
  officialSite?: string;
  discordInvite?: string | null;
  description?: string | null;
  bannerUrl?: string | null;
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

function ensureHttpsPrefix(raw: string) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  return `https://${withoutProtocol}`;
}

function normalizeWebsite(raw: string | null | undefined) {
  const withProtocol = ensureHttpsPrefix(String(raw || ""));
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

function normalizeDiscordInvite(raw: string | null | undefined) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  try {
    const withProtocol = ensureHttpsPrefix(trimmed);
    const url = new URL(withProtocol);
    if (url.hostname.toLowerCase() !== "discord.gg") return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "") return null;
    url.protocol = "https:";
    url.hash = "";
    return `${url.origin}${pathname}`;
  } catch (_err) {
    return null;
  }
}

function normalizeBannerUrl(raw: string | null | undefined) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch (_err) {
    return null;
  }
}

function isMissingAdminBeneficiaryColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("admin_beneficiary_id");
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
    const payload = (await req.json()) as Payload;
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
    const isAdmin = Boolean(profile?.is_admin);

    let { data: server, error: serverErr } = await supabase
      .from("servers")
      .select("id,owner_id,admin_beneficiary_id")
      .eq("id", serverId)
      .maybeSingle();

    if (isMissingAdminBeneficiaryColumnError(serverErr)) {
      const fallback = await supabase
        .from("servers")
        .select("id,owner_id")
        .eq("id", serverId)
        .maybeSingle();
      server = fallback.data ? { ...fallback.data, admin_beneficiary_id: null } : null;
      serverErr = fallback.error;
    }

    if (serverErr) throw serverErr;
    if (!server) return errorResponse("Servidor não encontrado", 404);

    const isOwner = String(server.owner_id || "") === userId;
    const isBeneficiaryAdmin = String(server.admin_beneficiary_id || "") === userId;
    if (!isAdmin && !isOwner && !isBeneficiaryAdmin) {
      return errorResponse("Sem permissão para editar este servidor", 403);
    }

    const updatePayload: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      const name = String(payload.name || "").trim();
      if (!name) return errorResponse("Nome do servidor é obrigatório.", 400);
      if (name.length > 120) return errorResponse("Nome do servidor muito longo.", 400);
      updatePayload.name = name;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "officialSite")) {
      const normalizedSite = normalizeWebsite(payload.officialSite);
      if (!normalizedSite) return errorResponse("Site oficial inválido.", 400);
      updatePayload.official_site = normalizedSite;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "discordInvite")) {
      const raw = payload.discordInvite;
      if (raw === null || String(raw || "").trim() === "") {
        updatePayload.discord_invite = null;
      } else {
        const normalizedDiscord = normalizeDiscordInvite(raw);
        if (!normalizedDiscord) return errorResponse("Convite do Discord inválido. Use https://discord.gg/...", 400);
        updatePayload.discord_invite = normalizedDiscord;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "description")) {
      const description = String(payload.description || "").trim();
      updatePayload.description = description ? description.slice(0, 2000) : null;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "bannerUrl")) {
      const raw = payload.bannerUrl;
      if (raw === null || String(raw || "").trim() === "") {
        updatePayload.banner_url = null;
      } else {
        const normalizedBanner = normalizeBannerUrl(raw);
        if (!normalizedBanner) return errorResponse("URL da logo inválida.", 400);
        updatePayload.banner_url = normalizedBanner;
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return errorResponse("Nenhuma alteração informada.", 400);
    }

    const { data: updatedServer, error: updateErr } = await supabase
      .from("servers")
      .update(updatePayload)
      .eq("id", serverId)
      .select("id,name,official_site,discord_invite,description,banner_url,status,created_at")
      .single();

    if (updateErr) throw updateErr;

    return jsonResponse({
      ok: true,
      server: updatedServer,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao atualizar servidor", 500);
  }
});
