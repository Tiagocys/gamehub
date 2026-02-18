import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";

if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

type ActionType = "handled" | "delete-listing" | "ban-user";
type Payload = {
  reportId?: string;
  action?: ActionType;
  note?: string;
  userToken?: string;
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL");
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const textEncoder = new TextEncoder();

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function encodeRFC3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(message: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(message));
  return toHex(digest);
}

async function hmacSha256(key: Uint8Array, data: string) {
  const normalizedKey = Uint8Array.from(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    normalizedKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(data));
  return new Uint8Array(signature);
}

async function getSignatureKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = await hmacSha256(textEncoder.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

function buildCanonicalQuery(params: Record<string, string>) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeRFC3986(key)}=${encodeRFC3986(params[key])}`)
    .join("&");
}

function parseR2Key(raw: string): string | null {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return decodeURIComponent(value.replace(/^\/+/, ""));
  }

  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!path) return null;

    if (R2_PUBLIC_URL) {
      try {
        const publicHost = new URL(R2_PUBLIC_URL).host;
        if (url.host === publicHost) return path;
      } catch (_err) {
        // ignore
      }
    }

    if (R2_BUCKET && path.startsWith(`${R2_BUCKET}/`)) {
      return path.slice(R2_BUCKET.length + 1);
    }

    if (url.host.includes(".r2.cloudflarestorage.com") && R2_BUCKET) {
      const marker = `/${R2_BUCKET}/`;
      const idx = url.pathname.indexOf(marker);
      if (idx >= 0) {
        return decodeURIComponent(url.pathname.slice(idx + marker.length));
      }
    }

    if (url.host.endsWith(".r2.dev")) {
      return path;
    }
  } catch (_err) {
    return null;
  }

  return null;
}

function ensureR2Configured() {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    throw new Error("Variáveis R2 não configuradas.");
  }
}

async function buildDeleteUrl(key: string) {
  ensureR2Configured();
  const endpoint = R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const canonicalUri = `/${R2_BUCKET}/${key.split("/").map(encodeRFC3986).join("/")}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = "host";

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${R2_ACCESS_KEY_ID}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": "120",
    "X-Amz-SignedHeaders": signedHeaders,
  };

  const canonicalQuery = buildCanonicalQuery(queryParams);
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const hashedRequest = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashedRequest,
  ].join("\n");

  const signingKey = await getSignatureKey(R2_SECRET_ACCESS_KEY!, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBytes.buffer);

  return `${endpointUrl.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function deleteR2Object(key: string) {
  const url = await buildDeleteUrl(key);
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao excluir objeto R2 (${response.status}): ${body}`);
  }
}

function collectR2Keys(items: unknown[], prefixes: string[]) {
  return Array.from(new Set(
    items
      .map((item) => parseR2Key(String(item)))
      .filter((key): key is string => Boolean(key && prefixes.some((prefix) => key.startsWith(prefix)))),
  ));
}

async function deleteR2Keys(keys: string[]) {
  if (!keys.length) return { deleted: 0, failed: 0 };
  ensureR2Configured();
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await deleteR2Object(key);
      deleted += 1;
    } catch (err) {
      failed += 1;
      console.error(`Falha ao excluir ${key}`, err);
    }
  }
  return { deleted, failed };
}

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toMultilineHtml(value: string) {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

async function sendListingDeletedEmail(params: {
  to: string;
  firstName: string;
  listingTitle: string;
  reason: string;
}) {
  const host = Deno.env.get("SMTP_HOST");
  const port = Number(Deno.env.get("SMTP_PORT") || "465");
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  const baseUrlRaw = Deno.env.get("EMAIL_ASSET_BASE_URL") || "http://localhost:8788";
  const baseUrl = baseUrlRaw.replace(/\/+$/, "");
  const logoUrl = `${baseUrl}/img/logo.png`;

  if (!host || !user || !pass) {
    throw new Error("Variáveis SMTP faltando para envio de e-mail de moderação.");
  }

  const subject = `Seu anúncio "${params.listingTitle}" foi excluído`;
  const textContent = [
    `Olá ${params.firstName || "jogador(a)"},`,
    "",
    `Seu anúncio "${params.listingTitle}" foi excluído pela moderação da Gimerr.`,
    `Motivo: ${params.reason}`,
    "",
    "Se necessário, você pode criar um novo anúncio corrigindo as informações.",
  ].join("\n");

  const htmlContent = `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f4f7ff;font-family:Arial,sans-serif;">
    <div style="padding:28px 10px;background:
      radial-gradient(circle at 20% 20%, rgba(0,194,255,0.09), transparent 30%),
      radial-gradient(circle at 80% 0%, rgba(14,165,233,0.1), transparent 32%),
      linear-gradient(150deg, #f8faff 0%, #eef2fb 42%, #f9fbff 100%);">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border-collapse:collapse;background:#ffffff;border:1px solid #e0e6f4;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="padding:26px 24px;background:linear-gradient(120deg,#0d1b3b,#1b4fd3);">
                  <img src="${escapeHtml(logoUrl)}" alt="Gimerr" style="display:block;height:40px;width:auto;max-width:160px;" />
                  <h1 style="margin:16px 0 8px;color:#ffffff;font-size:24px;line-height:1.2;">Anúncio removido</h1>
                  <p style="margin:0;color:#dbe6ff;font-size:14px;line-height:1.6;">Seu anúncio foi excluído após análise da moderação.</p>
                </td>
              </tr>
              <tr>
                <td style="padding:24px;">
                  <p style="margin:0 0 14px;color:#233154;font-size:15px;line-height:1.7;">Olá ${escapeHtml(params.firstName || "jogador(a)")},</p>
                  <p style="margin:0 0 12px;color:#233154;font-size:15px;line-height:1.7;">
                    O anúncio <strong>${escapeHtml(params.listingTitle)}</strong> foi excluído pela moderação.
                  </p>
                  <div style="margin:0 0 14px;background:#fff2f4;border:1px solid #ffd6de;border-radius:10px;padding:12px 14px;color:#8f2f42;font-size:14px;line-height:1.6;">
                    <strong>Motivo:</strong> ${toMultilineHtml(params.reason)}
                  </div>
                  <p style="margin:0;color:#516081;font-size:14px;line-height:1.7;">
                    Você pode publicar um novo anúncio com as correções necessárias.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>
  `.trim();

  const client = new SmtpClient();
  await client.connectTLS({ hostname: host, port, username: user, password: pass });
  await client.send({
    from: user,
    to: params.to,
    subject,
    content: textContent,
    html: htmlContent,
  });
  await client.close();
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes.", 500);
    }

    const payload = (await req.json()) as Payload;
    const reportId = String(payload.reportId || "").trim();
    const action = payload.action;
    const note = String(payload.note || "").trim();
    if (!reportId) return errorResponse("reportId é obrigatório.");
    if (!action || !["handled", "delete-listing", "ban-user"].includes(action)) {
      return errorResponse("Ação inválida.");
    }
    if (action === "delete-listing" && note.length < 10) {
      return errorResponse("Informe o motivo da exclusão com pelo menos 10 caracteres.");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const token =
      String(payload.userToken || "").trim() ||
      (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) {
      return errorResponse("Não autorizado.", 401);
    }

    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida.", 401);
    }

    const { data: adminProfile, error: adminProfileError } = await supabase
      .from("users")
      .select("id,is_admin")
      .eq("id", authData.user.id)
      .single();
    if (adminProfileError || !adminProfile?.is_admin) {
      return errorResponse("Acesso restrito ao administrador.", 403);
    }

    const { data: report, error: reportError } = await supabase
      .from("reports")
      .select("id,target_type,listing_id,reported_user_id,reason,status,evidence_images")
      .eq("id", reportId)
      .single();
    if (reportError || !report) {
      return errorResponse("Denúncia não encontrada.", 404);
    }
    if (report.status === "handled") {
      return new Response(JSON.stringify({ ok: true, alreadyHandled: true }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    const nowIso = new Date().toISOString();
    const baseHandledPayload = {
      status: "handled",
      handled_at: nowIso,
      handled_by_admin_id: adminProfile.id,
      admin_note: note || null,
    };

    if (action === "handled") {
      const reportEvidenceKeys = collectR2Keys(
        Array.isArray(report.evidence_images) ? report.evidence_images : [],
        ["reports/"],
      );

      const { error: updateError } = await supabase
        .from("reports")
        .update({
          ...baseHandledPayload,
          action_taken: "marked_handled",
          evidence_images: [],
        })
        .eq("id", report.id)
        .eq("status", "pending");
      if (updateError) throw updateError;

      const evidenceDelete = await deleteR2Keys(reportEvidenceKeys);
      return new Response(JSON.stringify({
        ok: true,
        action,
        deletedEvidenceKeys: evidenceDelete.deleted,
        failedEvidenceKeys: evidenceDelete.failed,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    if (action === "delete-listing") {
      if (report.target_type !== "listing" || !report.listing_id) {
        return errorResponse("A denúncia não está vinculada a um anúncio.");
      }

      const { data: listing, error: listingError } = await supabase
        .from("listings")
        .select("id,title,user_id,images")
        .eq("id", report.listing_id)
        .single();
      if (listingError) throw listingError;
      if (!listing) return errorResponse("Anúncio não encontrado.");

      const listingImageKeys = collectR2Keys(
        Array.isArray(listing.images) ? listing.images : [],
        [`listings/${listing.user_id}/`],
      );

      const { data: relatedPendingReports, error: relatedReportsError } = await supabase
        .from("reports")
        .select("id,evidence_images")
        .eq("listing_id", listing.id)
        .eq("status", "pending");
      if (relatedReportsError) throw relatedReportsError;

      const reportIds = (relatedPendingReports || []).map((item) => item?.id).filter(Boolean);
      const reportEvidenceKeys = collectR2Keys(
        (relatedPendingReports || []).flatMap((item) =>
          Array.isArray(item?.evidence_images) ? item.evidence_images : []
        ),
        ["reports/"],
      );

      const { data: ownerProfile, error: ownerProfileError } = await supabase
        .from("users")
        .select("id,email,first_name,last_name")
        .eq("id", listing.user_id)
        .maybeSingle();
      if (ownerProfileError && ownerProfileError.code !== "PGRST116") throw ownerProfileError;

      const { error: deleteListingError } = await supabase
        .from("listings")
        .delete()
        .eq("id", listing.id);
      if (deleteListingError) throw deleteListingError;

      if (reportIds.length > 0) {
        const { error: updateRelatedError } = await supabase
          .from("reports")
          .update({
            ...baseHandledPayload,
            action_taken: "listing_deleted",
            evidence_images: [],
          })
          .in("id", reportIds);
        if (updateRelatedError) throw updateRelatedError;
      }

      const listingDelete = await deleteR2Keys(listingImageKeys);
      const evidenceDelete = await deleteR2Keys(reportEvidenceKeys);

      let emailSent = false;
      let emailError: string | null = null;
      if (ownerProfile?.email) {
        try {
          await sendListingDeletedEmail({
            to: ownerProfile.email,
            firstName: ownerProfile.first_name || ownerProfile.last_name || "jogador(a)",
            listingTitle: listing.title || "seu anúncio",
            reason: note,
          });
          emailSent = true;
        } catch (err) {
          emailError = err instanceof Error ? err.message : String(err);
          console.error("Falha ao enviar e-mail de exclusão de anúncio", err);
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        action,
        listingDeleted: true,
        handledReports: reportIds.length,
        deletedListingImageKeys: listingDelete.deleted,
        failedListingImageKeys: listingDelete.failed,
        deletedEvidenceKeys: evidenceDelete.deleted,
        failedEvidenceKeys: evidenceDelete.failed,
        emailSent,
        emailError,
      }), {
        headers: { "content-type": "application/json", ...corsHeaders },
      });
    }

    let targetUserId = report.reported_user_id || null;
    if (!targetUserId && report.listing_id) {
      const { data: listingOwner, error: listingOwnerError } = await supabase
        .from("listings")
        .select("user_id")
        .eq("id", report.listing_id)
        .single();
      if (listingOwnerError) throw listingOwnerError;
      targetUserId = listingOwner?.user_id || null;
    }
    if (!targetUserId) {
      return errorResponse("Não foi possível identificar o usuário denunciado.");
    }

    const { data: userListings, error: userListingsError } = await supabase
      .from("listings")
      .select("id,user_id,images")
      .eq("user_id", targetUserId);
    if (userListingsError) throw userListingsError;
    const listingIds = (userListings || []).map((item) => item.id);

    const listingImageKeys = collectR2Keys(
      (userListings || []).flatMap((item) => Array.isArray(item?.images) ? item.images : []),
      [`listings/${targetUserId}/`],
    );

    let listingReportsEvidenceKeys: string[] = [];
    if (listingIds.length > 0) {
      const { data: listingReports, error: listingReportsError } = await supabase
        .from("reports")
        .select("evidence_images")
        .in("listing_id", listingIds);
      if (!listingReportsError) {
        listingReportsEvidenceKeys = collectR2Keys(
          (listingReports || []).flatMap((item) => Array.isArray(item?.evidence_images) ? item.evidence_images : []),
          ["reports/"],
        );
      }
    }

    const currentReportEvidenceKeys = collectR2Keys(
      Array.isArray(report.evidence_images) ? report.evidence_images : [],
      ["reports/"],
    );
    const reportEvidenceKeys = Array.from(new Set([...listingReportsEvidenceKeys, ...currentReportEvidenceKeys]));

    const { error: banError } = await supabase
      .from("users")
      .update({ status: "banned" })
      .eq("id", targetUserId);
    if (banError) throw banError;

    const { error: deleteListingsError } = await supabase
      .from("listings")
      .delete()
      .eq("user_id", targetUserId);
    if (deleteListingsError) throw deleteListingsError;

    const { error: updateReportError } = await supabase
      .from("reports")
      .update({
        ...baseHandledPayload,
        action_taken: "user_banned",
        evidence_images: [],
      })
      .eq("id", report.id);
    if (updateReportError) throw updateReportError;

    const listingDelete = await deleteR2Keys(listingImageKeys);
    const evidenceDelete = await deleteR2Keys(reportEvidenceKeys);

    return new Response(JSON.stringify({
      ok: true,
      action,
      bannedUserId: targetUserId,
      deletedListings: listingIds.length,
      deletedListingImageKeys: listingDelete.deleted,
      failedListingImageKeys: listingDelete.failed,
      deletedEvidenceKeys: evidenceDelete.deleted,
      failedEvidenceKeys: evidenceDelete.failed,
    }), {
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao moderar denúncia.", 500);
  }
});
