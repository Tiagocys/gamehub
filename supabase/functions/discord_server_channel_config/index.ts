import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { createDiscordChannelInvite, listDiscordGuildAnnouncementChannels, sendDiscordTestConnectionMessage } from "../_shared/discord_bot.ts";

type Payload = {
  userToken?: string;
  providerToken?: string;
  serverId?: string;
  channelId?: string | null;
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
    const channelId = normalizeSnowflake(body.channelId);
    if (!token || !providerToken || !serverId) return errorResponse("Payload inválido", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) return errorResponse("Sessão inválida", 401);

    const { data: serverRow, error: serverErr } = await supabase
      .from("servers")
      .select("id,name,owner_id,admin_beneficiary_id,status,discord_guild_id")
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
    if (!guildId) return errorResponse("Este servidor ainda não está vinculado ao Discord.", 409);

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

    let selectedChannelName = "";
    let inviteUrl: string | null = null;
    let testMessageSent = false;
    let permissionState = {
      administrator: false,
      createInvite: false,
      viewChannels: false,
      sendMessages: false,
      embedLinks: false,
    };
    if (channelId) {
      const channelsResult = await listDiscordGuildAnnouncementChannels(guildId);
      permissionState = channelsResult.permissionState || permissionState;
      if (!permissionState.viewChannels) {
        return errorResponse("O App do Gimerr não tem permissão para ver canais neste servidor. Autorize novamente o App para continuar.", 409);
      }
      const selected = channelsResult.channels.find((item) => item.id === channelId);
      if (!selected) {
        return errorResponse("O canal selecionado não está disponível para este bot.", 400);
      }
      selectedChannelName = selected.name;
      if (permissionState.createInvite) {
        try {
          const invite = await createDiscordChannelInvite(channelId);
          inviteUrl = String(invite.url || "").trim() || null;
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err || "").trim();
          if (!message.includes("sem permissões obrigatórias")) throw err;
          inviteUrl = null;
        }
      }
      if (permissionState.sendMessages && permissionState.embedLinks) {
        try {
          await sendDiscordTestConnectionMessage(channelId, String(serverRow.name || "Servidor"));
          testMessageSent = true;
        } catch (err) {
          const message = String(err instanceof Error ? err.message : err || "").trim();
          if (!message.includes("sem permissões obrigatórias")) throw err;
          testMessageSent = false;
        }
      }
    }

    const { error: updateErr } = await supabase
      .from("servers")
      .update({
        discord_announcement_channel_id: channelId || null,
        discord_announcement_channel_name: channelId ? selectedChannelName : null,
        discord_invite: inviteUrl,
        discord_app_installed: true,
        discord_app_can_create_invite: Boolean(permissionState.createInvite),
        discord_app_can_view_channels: Boolean(permissionState.viewChannels),
        discord_app_can_send_messages: Boolean(permissionState.sendMessages),
        discord_app_can_embed_links: Boolean(permissionState.embedLinks),
        discord_app_permissions_synced_at: new Date().toISOString(),
        status: channelId ? "active" : "pending",
      })
      .eq("id", serverRow.id);
    if (updateErr) throw updateErr;

    return new Response(JSON.stringify({
      ok: true,
      serverId: serverRow.id,
      channelId: channelId || null,
      channelName: channelId ? selectedChannelName : null,
      inviteUrl,
      permissionState,
      testMessageSent,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
