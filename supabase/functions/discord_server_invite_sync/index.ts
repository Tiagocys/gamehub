import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { createDiscordChannelInvite, listDiscordGuildAnnouncementChannels } from "../_shared/discord_bot.ts";

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

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
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
      .select("id,name,owner_id,admin_beneficiary_id,status,discord_guild_id,discord_announcement_channel_id,discord_invite")
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
    const channelId = normalizeSnowflake(serverRow.discord_announcement_channel_id);
    if (!guildId) return errorResponse("Este servidor ainda não está vinculado ao Discord.", 409);
    if (!channelId) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "channel_not_configured",
        inviteUrl: String(serverRow.discord_invite || "").trim() || null,
      });
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
    if (!permissionState.createInvite) {
      const { error: clearErr } = await supabase
        .from("servers")
        .update({
          discord_invite: null,
        })
        .eq("id", serverRow.id);
      if (clearErr) throw clearErr;
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "create_invite_permission_missing",
        inviteUrl: null,
      });
    }

    const invite = await createDiscordChannelInvite(channelId);
    const inviteUrl = String(invite.url || "").trim();
    if (!inviteUrl) return errorResponse("Não foi possível gerar o convite do Discord.", 500);

    const { error: updateErr } = await supabase
      .from("servers")
      .update({
        discord_invite: inviteUrl,
      })
      .eq("id", serverRow.id);
    if (updateErr) throw updateErr;

    return jsonResponse({
      ok: true,
      skipped: false,
      serverId: serverRow.id,
      inviteUrl,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro interno", 500);
  }
});
