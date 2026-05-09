const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_TEXT_CHANNEL_TYPES = new Set([0, 5]);
const DISCORD_PERMISSION_CREATE_INSTANT_INVITE = 0x1n;
const DISCORD_PERMISSION_VIEW_CHANNEL = 0x400n;
const DISCORD_PERMISSION_SEND_MESSAGES = 0x800n;
const DISCORD_PERMISSION_EMBED_LINKS = 0x4000n;
const DISCORD_PERMISSION_ADMINISTRATOR = 0x8n;
const DISCORD_REQUIRED_APP_PERMISSIONS =
  DISCORD_PERMISSION_CREATE_INSTANT_INVITE
  | DISCORD_PERMISSION_VIEW_CHANNEL
  | DISCORD_PERMISSION_SEND_MESSAGES
  | DISCORD_PERMISSION_EMBED_LINKS;

export class DiscordRateLimitError extends Error {
  retryAfterMs: number;
  isGlobal: boolean;

  constructor(message: string, retryAfterMs = 0, isGlobal = false) {
    super(message);
    this.name = "DiscordRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.isGlobal = isGlobal;
  }
}

export type DiscordChannelSummary = {
  id: string;
  name: string;
  type: number;
};

type DiscordChannelListResult = {
  ok: true;
  botPresent: boolean;
  permissionsReady: boolean;
  permissionState: {
    administrator: boolean;
    createInvite: boolean;
    viewChannels: boolean;
    sendMessages: boolean;
    embedLinks: boolean;
  };
  channels: DiscordChannelSummary[];
  inviteUrl: string;
};

type DiscordGuildRole = {
  id?: string;
  permissions?: string;
};

type DiscordGuildMember = {
  roles?: string[];
};

function normalizeSnowflake(value: unknown) {
  const text = String(value || "").trim();
  return /^[0-9]{17,20}$/.test(text) ? text : "";
}

function parsePermissions(value: unknown) {
  const raw = String(value || "0").trim();
  try {
    return BigInt(raw || "0");
  } catch (_err) {
    return 0n;
  }
}

async function getDiscordBotGuildPermissions(guildId: string) {
  const botUserId = normalizeSnowflake(getDiscordBotClientId());
  if (!botUserId) {
    throw new Error("DISCORD_BOT_CLIENT_ID não configurado.");
  }

  const [memberResponse, rolesResponse] = await Promise.all([
    discordRequest(`/guilds/${guildId}/members/${botUserId}`, { method: "GET" }),
    discordRequest(`/guilds/${guildId}/roles`, { method: "GET" }),
  ]);

  if (memberResponse.status === 404 || rolesResponse.status === 404) {
    return {
      botPresent: false,
      permissionsReady: false,
      permissions: 0n,
      permissionState: {
        administrator: false,
        createInvite: false,
        viewChannels: false,
        sendMessages: false,
        embedLinks: false,
      },
    };
  }
  if (memberResponse.status === 403 || rolesResponse.status === 403) {
    return {
      botPresent: true,
      permissionsReady: false,
      permissions: 0n,
      permissionState: {
        administrator: false,
        createInvite: false,
        viewChannels: false,
        sendMessages: false,
        embedLinks: false,
      },
    };
  }
  if (memberResponse.status === 429 || rolesResponse.status === 429) {
    const source = memberResponse.status === 429 ? memberResponse : rolesResponse;
    const payload = await source.json().catch(() => null);
    const retryAfterMs = Math.max(0, Math.round(Number(payload?.retry_after || 0) * 1000));
    throw new DiscordRateLimitError(
      String(payload?.message || "Discord is rate limiting this request."),
      retryAfterMs,
      Boolean(payload?.global),
    );
  }
  if (!memberResponse.ok) {
    const message = await readDiscordErrorText(memberResponse, "Não foi possível validar as permissões do App no Discord.");
    throw new Error(message);
  }
  if (!rolesResponse.ok) {
    const message = await readDiscordErrorText(rolesResponse, "Não foi possível validar os cargos do App no Discord.");
    throw new Error(message);
  }

  const member = await memberResponse.json().catch(() => null) as DiscordGuildMember | null;
  const roles = await rolesResponse.json().catch(() => []) as DiscordGuildRole[];
  const roleIds = new Set(Array.isArray(member?.roles) ? member.roles.map((roleId) => normalizeSnowflake(roleId)).filter(Boolean) : []);
  let permissions = 0n;
  if (Array.isArray(roles)) {
    roles.forEach((role) => {
      const roleId = normalizeSnowflake(role?.id);
      if (!roleId || !roleIds.has(roleId)) return;
      permissions |= parsePermissions(role?.permissions);
    });
  }
  const administrator = (permissions & DISCORD_PERMISSION_ADMINISTRATOR) === DISCORD_PERMISSION_ADMINISTRATOR;
  const permissionState = {
    administrator,
    createInvite: administrator || (permissions & DISCORD_PERMISSION_CREATE_INSTANT_INVITE) === DISCORD_PERMISSION_CREATE_INSTANT_INVITE,
    viewChannels: administrator || (permissions & DISCORD_PERMISSION_VIEW_CHANNEL) === DISCORD_PERMISSION_VIEW_CHANNEL,
    sendMessages: administrator || (permissions & DISCORD_PERMISSION_SEND_MESSAGES) === DISCORD_PERMISSION_SEND_MESSAGES,
    embedLinks: administrator || (permissions & DISCORD_PERMISSION_EMBED_LINKS) === DISCORD_PERMISSION_EMBED_LINKS,
  };
  const permissionsReady = permissionState.viewChannels && permissionState.sendMessages && permissionState.embedLinks;
  return { botPresent: true, permissionsReady, permissions, permissionState };
}

export function getDiscordBotToken() {
  return String(
    Deno.env.get("BOT_DISCORD_TOKEN")
    || Deno.env.get("bot_discord_token")
    || "",
  ).trim();
}

export function getDiscordBotClientId() {
  return String(
    Deno.env.get("DISCORD_BOT_CLIENT_ID")
    || Deno.env.get("DISCORD_CLIENT_ID")
    || "1500574981959061654"
    || "",
  ).trim();
}

export function getDiscordBotInviteUrl(options: { guildId?: string; disableGuildSelect?: boolean; permissions?: string } = {}) {
  const explicit = String(Deno.env.get("DISCORD_BOT_INVITE_URL") || "").trim();
  if (explicit) return explicit;
  const clientId = getDiscordBotClientId();
  if (!clientId) return "";
  const permissions = String(options.permissions || Deno.env.get("DISCORD_BOT_PERMISSIONS") || "0").trim() || "0";
  const params = new URLSearchParams({
    client_id: clientId,
    permissions,
    integration_type: "0",
    scope: "applications.commands bot",
  });
  const guildId = normalizeSnowflake(options.guildId);
  if (guildId) {
    params.set("guild_id", guildId);
    if (options.disableGuildSelect !== false) {
      params.set("disable_guild_select", "true");
    }
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function getPublicAppUrl() {
  const raw = String(
    Deno.env.get("SITE_URL")
    || Deno.env.get("EMAIL_ASSET_BASE_URL")
    || "https://gimerr.com",
  ).trim();
  return raw.replace(/\/+$/, "");
}

async function discordRequest(path: string, init: RequestInit = {}) {
  const botToken = getDiscordBotToken();
  if (!botToken) {
    throw new Error("BOT_DISCORD_TOKEN não configurado.");
  }
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bot ${botToken}`);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers,
  });
}

async function readDiscordErrorText(response: Response, fallback: string) {
  try {
    const payload = await response.json().catch(() => null);
    if (payload?.message) return String(payload.message);
  } catch (_err) {
    // ignore
  }
  const text = await response.text().catch(() => "");
  return text || fallback;
}

function isDiscordMissingPermissionsResponse(response: Response, message: string) {
  const text = String(message || "").trim().toLowerCase();
  return response.status === 403
    || text.includes("missing permissions")
    || text.includes("50013");
}

export async function listDiscordGuildAnnouncementChannels(guildId: string) {
  const normalizedGuildId = normalizeSnowflake(guildId);
  if (!normalizedGuildId) {
    throw new Error("Guild do Discord inválida.");
  }
  const guildResponse = await discordRequest(`/guilds/${normalizedGuildId}`, { method: "GET" });
  if (guildResponse.status === 403 || guildResponse.status === 404) {
    return {
      ok: true,
      botPresent: false,
      permissionsReady: false,
      permissionState: {
        administrator: false,
        createInvite: false,
        viewChannels: false,
        sendMessages: false,
        embedLinks: false,
      },
      channels: [] as DiscordChannelSummary[],
      inviteUrl: getDiscordBotInviteUrl({ guildId: normalizedGuildId }),
    } satisfies DiscordChannelListResult;
  }
  if (guildResponse.status === 429) {
    const payload = await guildResponse.json().catch(() => null);
    const retryAfterMs = Math.max(
      0,
      Math.round(Number(payload?.retry_after || 0) * 1000),
    );
    throw new DiscordRateLimitError(
      String(payload?.message || "Discord is rate limiting this request."),
      retryAfterMs,
      Boolean(payload?.global),
    );
  }
  if (!guildResponse.ok) {
    const message = await readDiscordErrorText(guildResponse, "Não foi possível validar a instalação do App no Discord.");
    throw new Error(message);
  }
  const permissionCheck = await getDiscordBotGuildPermissions(normalizedGuildId);
  if (!permissionCheck.botPresent) {
    return {
      ok: true,
      botPresent: false,
      permissionsReady: false,
      permissionState: permissionCheck.permissionState,
      channels: [] as DiscordChannelSummary[],
      inviteUrl: getDiscordBotInviteUrl({ guildId: normalizedGuildId }),
    } satisfies DiscordChannelListResult;
  }
  if (!permissionCheck.permissionState.viewChannels) {
    return {
      ok: true,
      botPresent: true,
      permissionsReady: false,
      permissionState: permissionCheck.permissionState,
      channels: [] as DiscordChannelSummary[],
      inviteUrl: getDiscordBotInviteUrl({ guildId: normalizedGuildId }),
    } satisfies DiscordChannelListResult;
  }
  const response = await discordRequest(`/guilds/${normalizedGuildId}/channels`, { method: "GET" });
  if (response.status === 404) {
    return {
      ok: true,
      botPresent: false,
      permissionsReady: false,
      permissionState: {
        administrator: false,
        createInvite: false,
        viewChannels: false,
        sendMessages: false,
        embedLinks: false,
      },
      channels: [] as DiscordChannelSummary[],
      inviteUrl: getDiscordBotInviteUrl({ guildId: normalizedGuildId }),
    } satisfies DiscordChannelListResult;
  }
  if (response.status === 403) {
    return {
      ok: true,
      botPresent: true,
      permissionsReady: false,
      permissionState: {
        ...permissionCheck.permissionState,
        viewChannels: false,
      },
      channels: [] as DiscordChannelSummary[],
      inviteUrl: getDiscordBotInviteUrl({ guildId: normalizedGuildId }),
    } satisfies DiscordChannelListResult;
  }
  if (response.status === 429) {
    const payload = await response.json().catch(() => null);
    const retryAfterMs = Math.max(
      0,
      Math.round(Number(payload?.retry_after || 0) * 1000),
    );
    throw new DiscordRateLimitError(
      String(payload?.message || "Discord is rate limiting this request."),
      retryAfterMs,
      Boolean(payload?.global),
    );
  }
  if (!response.ok) {
    const message = await readDiscordErrorText(response, "Não foi possível carregar os canais do Discord.");
    throw new Error(message);
  }
  const rows = await response.json().catch(() => []);
  const channels = Array.isArray(rows)
    ? rows
      .map((row) => ({
        id: normalizeSnowflake(row?.id),
        name: String(row?.name || "").trim(),
        type: Number(row?.type ?? -1),
      }))
      .filter((row) => row.id && row.name && DISCORD_TEXT_CHANNEL_TYPES.has(row.type))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    : [];
  return {
    ok: true,
    botPresent: true,
    permissionsReady: permissionCheck.permissionsReady,
    permissionState: permissionCheck.permissionState,
    channels,
    inviteUrl: getDiscordBotInviteUrl({ guildId: normalizedGuildId }),
  } satisfies DiscordChannelListResult;
}

export async function sendDiscordChannelMessage(channelId: string, payload: Record<string, unknown>) {
  const normalizedChannelId = normalizeSnowflake(channelId);
  if (!normalizedChannelId) {
    throw new Error("Canal do Discord inválido.");
  }
  const response = await discordRequest(`/channels/${normalizedChannelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const message = await readDiscordErrorText(response, "Não foi possível enviar a mensagem do App ao Discord.");
    if (isDiscordMissingPermissionsResponse(response, message)) {
      throw new Error("O App do Gimerr está sem permissões obrigatórias neste canal.");
    }
    throw new Error(message || "Não foi possível enviar a mensagem do App ao Discord.");
  }
  return response.json();
}

export async function sendDiscordTestConnectionMessage(channelId: string, serverName: string) {
  const safeName = String(serverName || "Servidor").trim() || "Servidor";
  return sendDiscordChannelMessage(channelId, {
    content: `O Gimerr foi conectado com sucesso a este canal para o servidor **${safeName}**.`,
    embeds: [{
      title: "App conectado",
      description: `O App do Gimerr está pronto para publicar novos anúncios de **${safeName}** neste canal.`,
      color: 0x101a2e,
    }],
    allowed_mentions: { parse: [] },
  });
}

export async function createDiscordChannelInvite(channelId: string) {
  const normalizedChannelId = normalizeSnowflake(channelId);
  if (!normalizedChannelId) {
    throw new Error("Canal do Discord inválido.");
  }
  const response = await discordRequest(`/channels/${normalizedChannelId}/invites`, {
    method: "POST",
    body: JSON.stringify({
      max_age: 0,
      max_uses: 0,
      temporary: false,
      unique: false,
    }),
  });
  if (!response.ok) {
    const message = await readDiscordErrorText(response, "Não foi possível criar o convite do Discord para este canal.");
    if (isDiscordMissingPermissionsResponse(response, message)) {
      throw new Error("O App do Gimerr está sem permissões obrigatórias neste canal.");
    }
    throw new Error(message || "Não foi possível criar o convite do Discord para este canal.");
  }
  const invite = await response.json().catch(() => null);
  const code = String(invite?.code || "").trim();
  if (!code) {
    throw new Error("O Discord não retornou um código de convite válido.");
  }
  return {
    code,
    url: `https://discord.gg/${code}`,
  };
}

export async function leaveDiscordGuild(guildId: string) {
  const normalizedGuildId = normalizeSnowflake(guildId);
  if (!normalizedGuildId) {
    throw new Error("Servidor do Discord inválido.");
  }
  const response = await discordRequest(`/users/@me/guilds/${normalizedGuildId}`, {
    method: "DELETE",
  });
  if (response.status === 204 || response.status === 404) {
    return { ok: true, removed: true };
  }
  if (response.status === 429) {
    const payload = await response.json().catch(() => null);
    const retryAfterMs = Math.max(
      0,
      Math.round(Number(payload?.retry_after || 0) * 1000),
    );
    throw new DiscordRateLimitError(
      String(payload?.message || "Discord is rate limiting this request."),
      retryAfterMs,
      Boolean(payload?.global),
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "Não foi possível remover o App do servidor no Discord.");
  }
  return { ok: true, removed: true };
}

export async function announceListingToDiscord(params: {
  supabase: any;
  listingId: string;
}) {
  const normalizedListingId = String(params.listingId || "").trim();
  if (!normalizedListingId) {
    return { ok: false, skipped: true, reason: "missing_listing_id" };
  }

  const { data: listingRow, error: listingErr } = await params.supabase
    .from("listings")
    .select("id,title,description,images,created_at,user_id,server_id,discord_announced_at,servers(id,name,discord_announcement_channel_id,discord_announcement_channel_name,status),users(username,first_name,discord_username)")
    .eq("id", normalizedListingId)
    .maybeSingle();
  if (listingErr) throw listingErr;
  if (!listingRow?.id) {
    return { ok: false, skipped: true, reason: "listing_not_found" };
  }
  if (listingRow.discord_announced_at) {
    return { ok: true, skipped: true, reason: "already_announced" };
  }

  const server = listingRow.servers || {};
  const channelId = normalizeSnowflake(server?.discord_announcement_channel_id);
  if (!channelId || String(server?.status || "") === "deleted") {
    return { ok: true, skipped: true, reason: "channel_not_configured" };
  }

  const username = String(listingRow?.users?.username || "").trim();
  const displayName = String(
    listingRow?.users?.first_name
    || listingRow?.users?.discord_username
    || username
    || "Membro da comunidade"
  ).trim() || "Membro da comunidade";
  const serverName = String(server?.name || "Servidor").trim() || "Servidor";
  const title = String(listingRow.title || "Novo anúncio").trim() || "Novo anúncio";
  const description = String(listingRow.description || "").trim();
  const listingUrl = `${getPublicAppUrl()}/listing?id=${encodeURIComponent(normalizedListingId)}`;
  const firstImage = Array.isArray(listingRow.images)
    ? String(listingRow.images.find((item: unknown) => String(item || "").trim()) || "").trim()
    : "";

  const embed: Record<string, unknown> = {
    title,
    url: listingUrl,
    description: description ? description.slice(0, 300) : `Novo anúncio publicado por ${displayName} em ${serverName}.`,
    color: 0x101a2e,
    author: { name: `Novo anúncio em ${serverName}` },
    footer: { text: `Publicado por ${displayName}` },
    timestamp: listingRow.created_at || new Date().toISOString(),
  };
  if (firstImage) {
    embed.image = { url: firstImage };
  }

  const message = await sendDiscordChannelMessage(channelId, {
    content: `Novo anúncio publicado no Gimerr por **${displayName}**: ${listingUrl}`,
    embeds: [embed],
    allowed_mentions: { parse: [] },
  });

  const messageId = normalizeSnowflake(message?.id);
  const { error: updateErr } = await params.supabase
    .from("listings")
    .update({
      discord_announced_at: new Date().toISOString(),
      discord_announcement_message_id: messageId || null,
    })
    .eq("id", normalizedListingId);
  if (updateErr) throw updateErr;

  return {
    ok: true,
    skipped: false,
    channelId,
    messageId: messageId || null,
  };
}
