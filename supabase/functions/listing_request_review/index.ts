import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  requestId?: string;
  approved?: boolean;
  note?: string;
  serverId?: string | null;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function ensureHttpsPrefix(raw: string) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const withoutWww = withoutProtocol.replace(/^www\./i, "");
  return `https://${withoutWww}`;
}

function extractDomainKey(raw: string) {
  try {
    const url = new URL(ensureHttpsPrefix(raw));
    return url.hostname.toLowerCase().replace(/^www\./, "");
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

    const body = (await req.json()) as Payload;
    if (!body.requestId || typeof body.approved !== "boolean") {
      return errorResponse("Payload inválido");
    }

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return errorResponse("Não autorizado", 401);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const token = authHeader.replace("Bearer ", "").trim();
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    const { data: adminRow, error: adminErr } = await supabase
      .from("users")
      .select("is_admin,email")
      .eq("id", authData.user.id)
      .single();
    if (adminErr) throw adminErr;
    if (!adminRow?.is_admin) {
      return errorResponse("Acesso restrito a admins", 403);
    }

    const { data: requestRow, error: requestErr } = await supabase
      .from("listing_requests")
      .select("id,user_id,user_email,title,description,images,game_name,website,website_domain,status")
      .eq("id", body.requestId)
      .single();
    if (requestErr || !requestRow) {
      return errorResponse("Solicitação de anúncio não encontrada", 404);
    }
    if (requestRow.status !== "pending") {
      return errorResponse("Solicitação de anúncio já processada", 409);
    }

    let resolvedServerId = body.serverId || null;
    if (body.approved) {
      if (!resolvedServerId) {
        const websiteDomain = requestRow.website_domain || extractDomainKey(requestRow.website || "");
        if (!websiteDomain) {
          return errorResponse("Website do game inválido para aprovação", 400);
        }
        const { data: serverRows, error: serverLookupErr } = await supabase
          .from("servers")
          .select("id")
          .eq("status", "active")
          .eq("website_domain", websiteDomain)
          .limit(1);
        if (serverLookupErr) throw serverLookupErr;
        resolvedServerId = serverRows?.[0]?.id || null;
      }

      if (!resolvedServerId) {
        return errorResponse("Nenhum servidor ativo encontrado para este anúncio. Crie o game antes de aprovar.", 409);
      }

      let insertPayload: Record<string, unknown> = {
        server_id: resolvedServerId,
        user_id: requestRow.user_id,
        title: requestRow.title,
        description: requestRow.description || null,
        images: Array.isArray(requestRow.images) ? requestRow.images : [],
        status: "active",
      };

      let insertedListingId: string | null = null;
      let insertError: { code?: string; message?: string } | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const insertResult = await supabase
          .from("listings")
          .insert(insertPayload)
          .select("id")
          .single();
        insertError = insertResult.error;
        if (!insertError) {
          insertedListingId = insertResult.data?.id || null;
          break;
        }

        break;
      }

      if (insertError) {
        const isDuplicateListing = insertError.code === "23505"
          && String(insertError.message || "").includes("listings_user_server_unique");
        if (isDuplicateListing) {
          return errorResponse("Este usuário já possui um anúncio para este game.", 409);
        }
        throw insertError;
      }

      const { error: updateErr } = await supabase
        .from("listing_requests")
        .update({
          status: "approved",
          server_id: resolvedServerId,
          listing_id: insertedListingId,
          review_note: body.note || null,
          reviewed_by_admin_id: authData.user.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", requestRow.id);
      if (updateErr) throw updateErr;

      return new Response(JSON.stringify({
        ok: true,
        approved: true,
        requestId: requestRow.id,
        serverId: resolvedServerId,
        listingId: insertedListingId,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const { error: rejectErr } = await supabase
      .from("listing_requests")
      .update({
        status: "rejected",
        review_note: body.note || null,
        reviewed_by_admin_id: authData.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", requestRow.id);
    if (rejectErr) throw rejectErr;

    const rejectLinkedGameNote = body.note
      ? `Solicitação de anúncio recusada: ${body.note}`
      : "Solicitação de anúncio recusada durante a análise.";
    const { error: rejectLinkedGameErr } = await supabase
      .from("game_requests")
      .update({
        status: "rejected",
        note: rejectLinkedGameNote,
        reviewed_by_admin_id: authData.user.id,
      })
      .eq("website_domain", requestRow.website_domain || extractDomainKey(requestRow.website || ""))
      .eq("user_id", requestRow.user_id)
      .in("status", ["pending", "under_review"]);
    if (rejectLinkedGameErr) throw rejectLinkedGameErr;

    return new Response(JSON.stringify({
      ok: true,
      approved: false,
      requestId: requestRow.id,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse("Erro ao revisar solicitação de anúncio", 500);
  }
});
