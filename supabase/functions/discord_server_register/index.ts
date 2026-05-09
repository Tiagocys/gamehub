import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  userToken?: string;
  providerToken?: string;
  guildId?: string;
};

type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
  permissions_new?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_ADMIN_PERMISSION = 0x8n;

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

function normalizeGuildId(value: unknown) {
  const text = String(value || "").trim();
  return /^[0-9]{17,20}$/.test(text) ? text : "";
}

function getGuildPermissions(guild: DiscordGuild) {
  const raw = String(guild.permissions_new || guild.permissions || "0").trim();
  try {
    return BigInt(raw || "0");
  } catch (_err) {
    return 0n;
  }
}

function canManageGuild(guild: DiscordGuild) {
  if (guild.owner) return true;
  return (getGuildPermissions(guild) & DISCORD_ADMIN_PERMISSION) === DISCORD_ADMIN_PERMISSION;
}

function buildGuildIconUrl(guild: DiscordGuild) {
  const guildId = normalizeGuildId(guild.id);
  const icon = String(guild.icon || "").trim();
  if (!guildId || !icon) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=256`;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }

    const payload = (await req.json().catch(() => ({}))) as Payload;
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token = payload.userToken?.trim()
      || (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) return errorResponse("Não autorizado", 401);

    const providerToken = String(payload.providerToken || "").trim();
    if (!providerToken) return errorResponse("Token do Discord ausente", 400);

    const guildId = normalizeGuildId(payload.guildId);
    if (!guildId) return errorResponse("guildId inválido", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const guildRes = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: {
        Authorization: `Bearer ${providerToken}`,
      },
    });
    if (!guildRes.ok) {
      const errorText = await guildRes.text().catch(() => "");
      console.error("Discord register server guilds error:", guildRes.status, errorText);
      return errorResponse("Não foi possível validar os servidores do Discord deste login.", 400);
    }

    const guildRows = (await guildRes.json().catch(() => [])) as DiscordGuild[];
    const guild = Array.isArray(guildRows)
      ? guildRows.find((item) => normalizeGuildId(item?.id) === guildId)
      : null;
    if (!guild) return errorResponse("Servidor do Discord não encontrado neste login.", 404);
    if (!canManageGuild(guild)) return errorResponse("Você precisa ser owner ou admin deste servidor no Discord.", 403);

    const { data: existingServer, error: existingErr } = await supabase
      .from("servers")
      .select("id,name,owner_id,admin_beneficiary_id,discord_guild_id,status")
      .eq("discord_guild_id", guildId)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existingServer?.id) {
      return new Response(JSON.stringify({
        ok: true,
        alreadyExists: true,
        server: existingServer,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const insertPayload = {
      name: String(guild.name || "Servidor").trim() || "Servidor",
      official_site: null,
      banner_url: buildGuildIconUrl(guild),
      status: "pending",
      owner_id: authData.user.id,
      owner_email: String(authData.user.email || "").trim().toLowerCase() || null,
      discord_guild_id: guildId,
      discord_invite: null,
      discord_app_installed: false,
      discord_app_can_create_invite: false,
      discord_app_can_view_channels: false,
      discord_app_can_send_messages: false,
      discord_app_can_embed_links: false,
      discord_app_permissions_synced_at: null,
      description: null,
    };

    const { data: insertedServer, error: insertErr } = await supabase
      .from("servers")
      .insert(insertPayload)
      .select("id,name,discord_guild_id,owner_id,status")
      .single();
    if (insertErr) throw insertErr;

    return new Response(JSON.stringify({
      ok: true,
      alreadyExists: false,
      server: insertedServer,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
