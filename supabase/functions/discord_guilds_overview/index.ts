import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  userToken?: string;
  providerToken?: string;
};

type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
  permissions_new?: string;
};

type GuildSyncTarget = {
  guildId: string;
  serverId: string;
  nextName: string;
  nextBannerUrl: string | null;
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
  if (!guildId || !icon) return "";
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=256`;
}

function normalizeNullableText(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
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
      console.error("Discord guilds overview error:", guildRes.status, errorText);
      return errorResponse("Não foi possível carregar os servidores do Discord para este login.", 400);
    }

    const guildRows = (await guildRes.json().catch(() => [])) as DiscordGuild[];
    const guilds = Array.isArray(guildRows)
      ? guildRows.map((guild) => ({
          id: normalizeGuildId(guild.id),
          name: String(guild.name || "Servidor").trim() || "Servidor",
          iconUrl: buildGuildIconUrl(guild),
          canManage: canManageGuild(guild),
        })).filter((guild) => guild.id)
      : [];

    const guildIds = guilds.map((guild) => guild.id);
    if (!guildIds.length) {
      return new Response(JSON.stringify({
        ok: true,
        matchedServers: [],
        manageableUnregisteredGuilds: [],
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const { data: serverRows, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,discord_guild_id,banner_url,owner_id,admin_beneficiary_id,status")
      .in("discord_guild_id", guildIds)
      .neq("status", "deleted");
    if (serverErr) throw serverErr;

    const serverByGuildId = new Map<string, any>();
    (serverRows || []).forEach((row) => {
      const guildId = normalizeGuildId(row?.discord_guild_id);
      if (guildId) serverByGuildId.set(guildId, row);
    });

    const syncTargets: GuildSyncTarget[] = guilds
      .filter((guild) => guild.canManage && serverByGuildId.has(guild.id))
      .map((guild) => {
        const server = serverByGuildId.get(guild.id);
        const canSyncServer = String(server?.owner_id || "") === String(authData.user.id || "")
          || String(server?.admin_beneficiary_id || "") === String(authData.user.id || "");
        if (!canSyncServer) return null;
        const currentName = String(server?.name || "").trim() || "Servidor";
        const currentBannerUrl = normalizeNullableText(server?.banner_url);
        const nextName = String(guild.name || "Servidor").trim() || "Servidor";
        const nextBannerUrl = normalizeNullableText(buildGuildIconUrl(guild)) || currentBannerUrl;
        if (currentName === nextName && currentBannerUrl === nextBannerUrl) return null;
        return {
          guildId: guild.id,
          serverId: String(server?.id || "").trim(),
          nextName,
          nextBannerUrl,
        };
      })
      .filter((target): target is GuildSyncTarget => Boolean(target));

    for (const target of syncTargets) {
      const { data: updatedServer, error: updateErr } = await supabase
        .from("servers")
        .update({
          name: target.nextName,
          banner_url: target.nextBannerUrl,
        })
        .eq("id", target.serverId)
        .select("id,name,discord_guild_id,banner_url,owner_id,admin_beneficiary_id,status")
        .single();
      if (updateErr) throw updateErr;
      serverByGuildId.set(target.guildId, updatedServer);
    }

    const matchedServerIds = (serverRows || []).map((row) => String(row?.id || "").trim()).filter(Boolean);
    const followedServerIds = new Set<string>();
    if (matchedServerIds.length) {
      const { data: followRows, error: followErr } = await supabase
        .from("server_follows")
        .select("server_id")
        .eq("user_id", authData.user.id)
        .in("server_id", matchedServerIds);
      if (followErr) throw followErr;
      (followRows || []).forEach((row) => {
        const serverId = String(row?.server_id || "").trim();
        if (serverId) followedServerIds.add(serverId);
      });
    }

    const matchedServers = guilds
      .filter((guild) => serverByGuildId.has(guild.id))
      .map((guild) => {
        const server = serverByGuildId.get(guild.id);
        const serverId = String(server?.id || "").trim();
        return {
          guildId: guild.id,
          guildName: guild.name,
          guildIconUrl: guild.iconUrl,
          canManage: guild.canManage,
          serverId,
          serverName: String(server?.name || guild.name || "Servidor").trim() || "Servidor",
          serverBannerUrl: String(server?.banner_url || "").trim(),
          isFollowing: followedServerIds.has(serverId),
        };
      })
      .sort((a, b) => Number(b.canManage) - Number(a.canManage) || a.serverName.localeCompare(b.serverName, "pt-BR"));

    const manageableUnregisteredGuilds = guilds
      .filter((guild) => guild.canManage && !serverByGuildId.has(guild.id))
      .map((guild) => ({
        guildId: guild.id,
        guildName: guild.name,
        guildIconUrl: guild.iconUrl,
      }))
      .sort((a, b) => a.guildName.localeCompare(b.guildName, "pt-BR"));

    return new Response(JSON.stringify({
      ok: true,
      matchedServers,
      manageableUnregisteredGuilds,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
