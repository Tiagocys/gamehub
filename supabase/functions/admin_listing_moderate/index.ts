import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";
import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts";
import { writeAll } from "https://deno.land/std@0.201.0/streams/write_all.ts";

if (!(Deno as any).writeAll) {
  (Deno as any).writeAll = writeAll;
}

type ActionType = "delete";

type Payload = {
  listingId?: string;
  reason?: string;
  evidenceImages?: string[];
  action?: ActionType;
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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
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

async function sendModerationEmail(params: {
  to: string;
  username: string;
  subject: string;
  title: string;
  body: string;
  termsUrl: string;
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

  const textContent = [
    `Olá, ${params.username || "usuário"}.`,
    "",
    params.body,
    "",
    `Antes de publicar novos anúncios, por favor leia os termos de uso: ${params.termsUrl}`,
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
                  <h1 style="margin:16px 0 8px;color:#ffffff;font-size:24px;line-height:1.2;">${escapeHtml(params.title)}</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:24px;">
                  <p style="margin:0 0 14px;color:#233154;font-size:15px;line-height:1.7;">Olá, ${escapeHtml(params.username || "usuário")}.</p>
                  <p style="margin:0 0 12px;color:#233154;font-size:15px;line-height:1.7;">
                    ${escapeHtml(params.body)}
                  </p>
                  <p style="margin:0;color:#516081;font-size:14px;line-height:1.7;">
                    Antes de publicar novos anúncios, por favor leia os <a href="${escapeHtml(params.termsUrl)}" style="color:#1b4fd3;">termos de uso</a>.
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
    subject: params.subject,
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
    const listingId = String(payload.listingId || "").trim();
    const reason = String(payload.reason || "").trim();
    const action = String(payload.action || "").trim() as ActionType;
    const evidenceImages = Array.isArray(payload.evidenceImages)
      ? payload.evidenceImages.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    if (!listingId) return errorResponse("listingId é obrigatório.");
    if (action !== "delete") return errorResponse("Ação inválida.");
    if (reason.length < 10) return errorResponse("Descreva a moderação com pelo menos 10 caracteres.");

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

    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("id,title,user_id,images")
      .eq("id", listingId)
      .single();
    if (listingError || !listing) {
      return errorResponse("Anúncio não encontrado.", 404);
    }

    const { data: ownerProfile, error: ownerProfileError } = await supabase
      .from("users")
      .select("id,email,username,first_name,last_name")
      .eq("id", listing.user_id)
      .maybeSingle();
    if (ownerProfileError) {
      return errorResponse("Erro ao buscar o anunciante.", 500);
    }
    if (!ownerProfile?.id) {
      return errorResponse("Anunciante não encontrado.", 404);
    }

    const nowIso = new Date().toISOString();
    let reportActionTaken: "listing_deleted" = "listing_deleted";
    let reportTargetType: "user" = "user";
    let deletedListingImageKeys = 0;
    let failedListingImageKeys = 0;
    let deletedEvidenceKeys = 0;
    let failedEvidenceKeys = 0;

    if (action === "delete") {
      const listingImageKeys = Array.from(new Set(
        (Array.isArray(listing.images) ? listing.images : [])
          .map((item) => parseR2Key(String(item)))
          .filter((key): key is string => Boolean(key && key.startsWith(`listings/${listing.user_id}/`))),
      ));
      const { data: listingReports, error: listingReportsError } = await supabase
        .from("reports")
        .select("evidence_images")
        .eq("listing_id", listing.id);
      if (listingReportsError && listingReportsError.code !== "42P01") {
        throw listingReportsError;
      }
      const reportEvidenceKeys = Array.from(new Set(
        (listingReports || [])
          .flatMap((item) => Array.isArray(item?.evidence_images) ? item.evidence_images : [])
          .map((item) => parseR2Key(String(item)))
          .filter((key): key is string => Boolean(key && key.startsWith("reports/"))),
      ));

      const { error: deleteListingError } = await supabase
        .from("listings")
        .delete()
        .eq("id", listing.id);
      if (deleteListingError) throw deleteListingError;

      const listingDelete = await deleteR2Keys(listingImageKeys);
      deletedListingImageKeys = listingDelete.deleted;
      failedListingImageKeys = listingDelete.failed;
      const evidenceDelete = await deleteR2Keys(reportEvidenceKeys);
      deletedEvidenceKeys = evidenceDelete.deleted;
      failedEvidenceKeys = evidenceDelete.failed;
    }

    const { data: report, error: insertError } = await supabase
      .from("reports")
      .insert({
        reporter_id: adminProfile.id,
        target_type: reportTargetType,
        reported_user_id: ownerProfile.id,
        reason,
        evidence_images: evidenceImages,
        status: "handled",
        action_taken: reportActionTaken,
        handled_by_admin_id: adminProfile.id,
        handled_at: nowIso,
        admin_note: `${listing.title || "Anúncio"} (${listing.id})`,
      })
      .select("id,status,action_taken,created_at,handled_at")
      .single();
    if (insertError) {
      return errorResponse(insertError.message || "Erro ao registrar moderação.", 500);
    }

    let emailSent = false;
    let emailError: string | null = null;
    if (ownerProfile.email) {
      try {
        await sendModerationEmail({
          to: ownerProfile.email,
          username: ownerProfile.username || ownerProfile.first_name || ownerProfile.last_name || "usuário",
          subject: `O anúncio "${listing.title || "sem título"}" foi removido.`,
          title: `O anúncio "${listing.title || "sem título"}" foi removido.`,
          body: `O anúncio "${listing.title || "sem título"}" foi removido do Gimerr porque descumpria as normas da comunidade.`,
          termsUrl: `${(Deno.env.get("SITE_URL") || "https://gimerr.com").replace(/\/+$/, "")}/terms.html`,
        });
        emailSent = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
        console.error("Falha ao enviar e-mail de moderação do anúncio", err);
      }
    }

    return jsonResponse({
      ok: true,
      action,
      report,
      emailSent,
      emailError,
      deletedListingImageKeys,
      failedListingImageKeys,
      deletedEvidenceKeys,
      failedEvidenceKeys,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "Erro ao moderar anúncio.", 500);
  }
});
