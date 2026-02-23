import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  requestId?: string | number;
  approved: boolean;
  note?: string;
  skipServerInsert?: boolean;
  override?: {
    name?: string;
    website?: string;
    discord_invite?: string | null;
    is_owner?: boolean;
    owner_id?: string | null;
    owner_email?: string | null;
    cover_url?: string | null;
  };
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const EMAIL_ENDPOINT = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/game_approve_email` : null;

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function isMissingReviewedByColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("reviewed_by_admin_id");
}

function isMissingDiscordInviteColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("discord_invite");
}

function isMissingOwnerIdColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("owner_id");
}

function isMissingOwnerEmailColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("owner_email");
}

function isMissingIsOwnerColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("is_owner");
}

function isMissingAdminBeneficiaryIdColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("admin_beneficiary_id");
}

function isMissingAdminBeneficiaryEmailColumnError(err: { code?: string; message?: string } | null | undefined) {
  if (!err) return false;
  return String(err.message || "").includes("admin_beneficiary_email");
}

function ensureHttpsPrefix(raw: string) {
  const trimmed = (raw || "").trim();
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
    const search = url.search || "";
    return `${url.origin}${pathname}${search}`;
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

function isSameUser(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b && String(a) === String(b));
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }
    const body = (await req.json()) as Payload;
    if (!body.requestId || typeof body.approved !== "boolean") {
      return errorResponse("Payload inválido");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse("Não autorizado", 401);
    }
    const token = authHeader.replace("Bearer ", "").trim();
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }
    const { data: adminData, error: adminErr } = await supabase
      .from("users")
      .select("is_admin")
      .eq("id", authData.user.id)
      .single();
    if (adminErr) throw adminErr;
    if (!adminData?.is_admin) {
      return errorResponse("Acesso restrito a admins", 403);
    }

    let { data: reqData, error: fetchErr } = await supabase
      .from("game_requests")
      .select("id,name,website,discord_invite,is_owner,cover_url,user_id,user_email,status,created_at")
      .eq("id", body.requestId)
      .single();
    if (isMissingDiscordInviteColumnError(fetchErr) && isMissingIsOwnerColumnError(fetchErr)) {
      const fallback = await supabase
        .from("game_requests")
        .select("id,name,website,cover_url,user_id,user_email,status,created_at")
        .eq("id", body.requestId)
        .single();
      reqData = fallback.data ? { ...fallback.data, discord_invite: null, is_owner: false } : null;
      fetchErr = fallback.error;
    } else if (isMissingDiscordInviteColumnError(fetchErr)) {
      const fallback = await supabase
        .from("game_requests")
        .select("id,name,website,is_owner,cover_url,user_id,user_email,status,created_at")
        .eq("id", body.requestId)
        .single();
      reqData = fallback.data ? { ...fallback.data, discord_invite: null } : null;
      fetchErr = fallback.error;
    } else if (isMissingIsOwnerColumnError(fetchErr)) {
      const fallback = await supabase
        .from("game_requests")
        .select("id,name,website,discord_invite,cover_url,user_id,user_email,status,created_at")
        .eq("id", body.requestId)
        .single();
      reqData = fallback.data ? { ...fallback.data, is_owner: false } : null;
      fetchErr = fallback.error;
    }
    if (fetchErr || !reqData) {
      return errorResponse("Solicitação não encontrada", 404);
    }

    if (reqData.status !== "pending" && reqData.status !== "under_review") {
      return errorResponse("Solicitação já processada", 409);
    }

    const finalName = body.override?.name?.trim() || reqData.name;
    const finalWebsiteRaw = body.override?.website?.trim() || reqData.website;
    const finalWebsite = normalizeWebsite(finalWebsiteRaw);
    const finalDiscordInvite = normalizeOptionalUrl(body.override?.discord_invite ?? reqData.discord_invite);
    const finalIsOwner = typeof body.override?.is_owner === "boolean" ? body.override.is_owner : Boolean(reqData.is_owner);
    const hasOwnerOverride = Object.prototype.hasOwnProperty.call(body.override || {}, "owner_id");
    const finalOwnerId = hasOwnerOverride
      ? (body.override?.owner_id || null)
      : (finalIsOwner ? reqData.user_id : null);
    const overrideOwnerEmail = String(body.override?.owner_email || "").trim() || null;
    let finalOwnerEmail = overrideOwnerEmail
      || (finalOwnerId && finalOwnerId === reqData.user_id ? (reqData.user_email || null) : null);
    if (finalOwnerId && !finalOwnerEmail) {
      const { data: ownerUser, error: ownerUserErr } = await supabase
        .from("users")
        .select("email")
        .eq("id", finalOwnerId)
        .maybeSingle();
      if (ownerUserErr) throw ownerUserErr;
      finalOwnerEmail = ownerUser?.email || null;
    }
    const finalCover = body.override?.cover_url ?? reqData.cover_url;
    const finalDomain = extractDomainKey(finalWebsiteRaw);

    if (!finalWebsite || !finalDomain) {
      return errorResponse("Website inválido para aprovação", 400);
    }
    if (body.approved && !finalDiscordInvite) {
      return errorResponse("Convite do Discord inválido. Use https://discord.gg/...", 400);
    }
    if (body.approved && isSameUser(finalOwnerId, authData.user.id)) {
      return errorResponse("Regra antifraude: o owner do servidor não pode ser o mesmo usuário que aprovou.", 409);
    }

    if (body.approved && body.skipServerInsert) {
      return errorResponse("Fluxo de aprovação inválido. Reenvie sem skipServerInsert.", 400);
    }

    if (body.approved && !body.skipServerInsert) {
      // Checa duplicidade por domínio normalizado.
      const { data: dupServer, error: dupErr } = await supabase
        .from("servers")
        .select("id,name,official_site")
        .eq("status", "active")
        .eq("website_domain", finalDomain)
        .limit(1);
      if (dupErr) throw dupErr;
      if (dupServer && dupServer.length > 0) {
        return errorResponse(`Servidor já cadastrado para o domínio ${finalDomain}`, 409);
      }

      let insertPayload: Record<string, unknown> = {
        name: finalName,
        official_site: finalWebsite,
        discord_invite: finalDiscordInvite,
        banner_url: finalCover,
        owner_id: finalOwnerId,
        owner_email: finalOwnerEmail,
        admin_beneficiary_id: authData.user.id,
        admin_beneficiary_email: authData.user.email || null,
        status: "active"
      };

      let insertErr: { code?: string; message?: string } | null = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const insertResult = await supabase.from("servers").insert(insertPayload);
        insertErr = insertResult.error;
        if (!insertErr) break;

        let removedAnyColumn = false;
        if (isMissingDiscordInviteColumnError(insertErr) && Object.prototype.hasOwnProperty.call(insertPayload, "discord_invite")) {
          const { discord_invite: _discordInvite, ...rest } = insertPayload;
          insertPayload = rest;
          removedAnyColumn = true;
        }
        if (isMissingOwnerIdColumnError(insertErr) && Object.prototype.hasOwnProperty.call(insertPayload, "owner_id")) {
          const { owner_id: _ownerId, ...rest } = insertPayload;
          insertPayload = rest;
          removedAnyColumn = true;
        }
        if (isMissingOwnerEmailColumnError(insertErr) && Object.prototype.hasOwnProperty.call(insertPayload, "owner_email")) {
          const { owner_email: _ownerEmail, ...rest } = insertPayload;
          insertPayload = rest;
          removedAnyColumn = true;
        }
        if (isMissingAdminBeneficiaryIdColumnError(insertErr) && Object.prototype.hasOwnProperty.call(insertPayload, "admin_beneficiary_id")) {
          const { admin_beneficiary_id: _adminBeneficiaryId, ...rest } = insertPayload;
          insertPayload = rest;
          removedAnyColumn = true;
        }
        if (isMissingAdminBeneficiaryEmailColumnError(insertErr) && Object.prototype.hasOwnProperty.call(insertPayload, "admin_beneficiary_email")) {
          const { admin_beneficiary_email: _adminBeneficiaryEmail, ...rest } = insertPayload;
          insertPayload = rest;
          removedAnyColumn = true;
        }
        if (!removedAnyColumn) break;
      }
      if (insertErr) {
        if (insertErr.code === "23505") {
          return errorResponse(`Servidor já cadastrado para o domínio ${finalDomain}`, 409);
        }
        throw insertErr;
      }
    }

    const approvedStatus = body.approved ? "approved" : "rejected";
    const baseRequestUpdate = {
      name: finalName,
      website: finalWebsite,
      discord_invite: finalDiscordInvite,
      is_owner: finalIsOwner,
      cover_url: finalCover,
      status: approvedStatus,
      note: body.note || null,
    };

    let requestUpdatePayload: Record<string, unknown> = { ...baseRequestUpdate, reviewed_by_admin_id: authData.user.id };
    let { error: updateErr } = await supabase
      .from("game_requests")
      .update(requestUpdatePayload)
      .eq("id", reqData.id);
    if (isMissingReviewedByColumnError(updateErr) || isMissingDiscordInviteColumnError(updateErr) || isMissingIsOwnerColumnError(updateErr)) {
      if (isMissingReviewedByColumnError(updateErr)) {
        const { reviewed_by_admin_id: _reviewedByAdminId, ...withoutReviewedByAdminId } = requestUpdatePayload;
        requestUpdatePayload = withoutReviewedByAdminId;
      }
      if (isMissingDiscordInviteColumnError(updateErr)) {
        const { discord_invite: _discordInvite, ...withoutDiscordInvite } = requestUpdatePayload;
        requestUpdatePayload = withoutDiscordInvite;
      }
      if (isMissingIsOwnerColumnError(updateErr)) {
        const { is_owner: _isOwner, ...withoutIsOwner } = requestUpdatePayload;
        requestUpdatePayload = withoutIsOwner;
      }
      const fallback = await supabase
        .from("game_requests")
        .update(requestUpdatePayload)
        .eq("id", reqData.id);
      updateErr = fallback.error;
    }
    if (updateErr) throw updateErr;

    if (body.approved) {
      const autoRejectNote = "Solicitação duplicada: já existe um servidor ativo para este domínio.";
      let { error: clearDupPendingErr } = await supabase
        .from("game_requests")
        .update({
          status: "rejected",
          note: autoRejectNote,
          reviewed_by_admin_id: authData.user.id,
        })
        .eq("website_domain", finalDomain)
        .neq("id", reqData.id)
        .in("status", ["pending", "under_review"]);
      if (isMissingReviewedByColumnError(clearDupPendingErr)) {
        const fallback = await supabase
          .from("game_requests")
          .update({
            status: "rejected",
            note: autoRejectNote,
          })
          .eq("website_domain", finalDomain)
          .neq("id", reqData.id)
          .in("status", ["pending", "under_review"]);
        clearDupPendingErr = fallback.error;
      }
      if (clearDupPendingErr) throw clearDupPendingErr;
    }

    if (reqData.user_email && EMAIL_ENDPOINT) {
      try {
        await fetch(EMAIL_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({
            to: reqData.user_email,
            gameName: finalName,
            approved: body.approved,
            note: body.note || "",
          }),
        });
      } catch (mailErr) {
        console.warn("Falha ao enviar e-mail de aprovação/recusa", mailErr);
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(String(err), 500);
  }
});
