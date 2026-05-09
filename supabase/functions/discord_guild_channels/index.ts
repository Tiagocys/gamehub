import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { getDiscordBotInviteUrl, listDiscordGuildAnnouncementChannels } from "../_shared/discord_bot.ts";

type Payload = {
  userToken?: string;
  providerToken?: string;
  serverId?: string;
};

type DiscordGuild = {
  id: string;
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

function normalizeSnowflake(value: unknown) {
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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (!SUPABASE_URL || !SERVICE_KEY) return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);

    const body = (await req.json().catch(() => ({}))) as Payload;
    const token = String(body.userToken || "").trim();
    const providerToken = String(body.providerToken || "").trim();
    const serverId = String(body.serverId || "").trim();
    if (!token || !providerToken || !serverId) return errorResponse("Payload inválido", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const { data: serverRow, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,owner_id,admin_beneficiary_id,status,discord_guild_id,discord_announcement_channel_id,discord_announcement_channel_name")
      .eq("id", serverId)
      .neq("status", "deleted")
      .maybeSingle();
    if (serverErr) throw serverErr;
    if (!serverRow?.id) return errorResponse("Servidor não encontrado", 404);

    const currentUserId = String(authData.user.id || "").trim();
    const isAllowedUser = currentUserId
      && (
        currentUserId === String(serverRow.owner_id || "").trim()
        || currentUserId === String(serverRow.admin_beneficiary_id || "").trim()
      );
    const { data: adminRow } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", currentUserId)
      .maybeSingle();
    if (!isAllowedUser && !adminRow?.is_admin) {
      return errorResponse("Acesso restrito ao parceiro responsável por este servidor.", 403);
    }

    const guildId = normalizeSnowflake(serverRow.discord_guild_id);
    if (!guildId) {
      return errorResponse("Este servidor do Gimerr ainda não está vinculado a um servidor do Discord.", 409);
    }

    const guildRes = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${providerToken}` },
    });
    if (!guildRes.ok) {
      return errorResponse("Não foi possível validar suas permissões no Discord. Entre novamente com o Discord.", 400);
    }
    const guildRows = (await guildRes.json().catch(() => [])) as DiscordGuild[];
    const guild = Array.isArray(guildRows)
      ? guildRows.find((item) => normalizeSnowflake(item?.id) === guildId)
      : null;
    if (!guild || !canManageGuild(guild)) {
      return errorResponse("Você precisa ser owner ou administrador desse servidor no Discord.", 403);
    }

    const channelsResult = await listDiscordGuildAnnouncementChannels(guildId);
    const permissionState = channelsResult.permissionState || {
      administrator: false,
      createInvite: false,
      viewChannels: false,
      sendMessages: false,
      embedLinks: false,
    };
    const permissionSyncPayload: Record<string, unknown> = {
      status: channelsResult.botPresent ? "active" : "pending",
      discord_app_installed: Boolean(channelsResult.botPresent),
      discord_app_can_create_invite: Boolean(permissionState.createInvite),
      discord_app_can_view_channels: Boolean(permissionState.viewChannels),
      discord_app_can_send_messages: Boolean(permissionState.sendMessages),
      discord_app_can_embed_links: Boolean(permissionState.embedLinks),
      discord_app_permissions_synced_at: new Date().toISOString(),
    };
    if (!channelsResult.botPresent) {
      permissionSyncPayload.discord_announcement_channel_id = null;
      permissionSyncPayload.discord_announcement_channel_name = null;
      permissionSyncPayload.discord_invite = null;
    } else if (!permissionState.viewChannels) {
      permissionSyncPayload.discord_announcement_channel_id = null;
      permissionSyncPayload.discord_announcement_channel_name = null;
    }
    if (!permissionState.createInvite) {
      permissionSyncPayload.discord_invite = null;
    }
    const { error: syncErr } = await supabase
      .from("servers")
      .update(permissionSyncPayload)
      .eq("id", serverRow.id);
    if (syncErr) throw syncErr;
    const currentChannelId = !channelsResult.botPresent || !permissionState.viewChannels
      ? ""
      : normalizeSnowflake(serverRow.discord_announcement_channel_id);
    const currentChannelName = !channelsResult.botPresent || !permissionState.viewChannels
      ? ""
      : String(serverRow.discord_announcement_channel_name || "").trim();
    return new Response(JSON.stringify({
      ok: true,
      botPresent: channelsResult.botPresent,
      permissionsReady: channelsResult.permissionsReady,
      permissionState,
      inviteUrl: channelsResult.botPresent
        ? (channelsResult.inviteUrl || getDiscordBotInviteUrl())
        : getDiscordBotInviteUrl({ guildId, permissions: "0" }),
      channels: channelsResult.channels,
      currentChannelId,
      currentChannelName,
      guildId,
      serverId: serverRow.id,
      serverName: serverRow.name,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
