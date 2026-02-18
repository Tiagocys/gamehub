import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  mode?: "put" | "delete";
  contentType?: string;
  extension?: string;
  key?: string;
  keys?: string[];
  userToken?: string;
  assetType?: "listing" | "avatar" | "report";
};

const SUPABASE_URL = Deno.env.get("PROJECT_URL");
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY");

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = Deno.env.get("R2_BUCKET");
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL");
const R2_PROFILE_BUCKET = Deno.env.get("R2_PROFILE_BUCKET") || R2_BUCKET;
const R2_PROFILE_PUBLIC_URL = Deno.env.get("R2_PROFILE_PUBLIC_URL") || R2_PUBLIC_URL;
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const textEncoder = new TextEncoder();

const allowedTypes: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

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
    ["sign"]
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

function sanitizeExtension(value?: string) {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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

async function buildDeleteUrl(key: string, bucket: string) {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !bucket) {
    throw new Error("Variáveis R2 não configuradas");
  }
  const endpoint = R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const canonicalUri = `/${bucket}/${key.split("/").map(encodeRFC3986).join("/")}`;

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

  const signingKey = await getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBytes.buffer);

  return `${endpointUrl.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function deleteR2Object(key: string) {
  if (!R2_BUCKET) {
    throw new Error("R2_BUCKET não configurado para deleção");
  }
  const url = await buildDeleteUrl(key, R2_BUCKET);
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao excluir objeto R2 (${response.status}): ${body}`);
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
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      return errorResponse("Variáveis R2 não configuradas", 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const payload = (await req.json()) as Payload;
    const token =
      payload.userToken?.trim() ||
      (authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "").trim() : "");
    if (!token) {
      return errorResponse("Não autorizado", 401);
    }
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return errorResponse("Sessão inválida", 401);
    }

    const mode = payload.mode || "put";

    if (mode === "delete") {
      if (!R2_BUCKET) {
        return errorResponse("R2_BUCKET não configurado para deleção", 500);
      }
      const rawItems = [
        ...(Array.isArray(payload.keys) ? payload.keys : []),
        ...(payload.key ? [payload.key] : []),
      ];
      const keys = Array.from(
        new Set(
          rawItems
            .map((item) => parseR2Key(String(item)))
            .filter((key): key is string => Boolean(key && key.startsWith(`listings/${authData.user.id}/`))),
        ),
      );

      let deletedKeys = 0;
      let failedKeys = 0;
      for (const key of keys) {
        try {
          await deleteR2Object(key);
          deletedKeys += 1;
        } catch (err) {
          failedKeys += 1;
          console.error(`Falha ao excluir objeto R2 ${key}`, err);
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          mode: "delete",
          deletedKeys,
          failedKeys,
        }),
        {
          headers: { "content-type": "application/json", ...corsHeaders },
        },
      );
    }

    const contentType = (payload.contentType || "").toLowerCase();
    if (!allowedTypes[contentType]) {
      return errorResponse("Tipo de arquivo não permitido", 415);
    }
    const sanitizedExt = sanitizeExtension(payload.extension);
    const allowedExts = new Set(Object.values(allowedTypes));
    const ext = allowedExts.has(sanitizedExt) ? sanitizedExt : allowedTypes[contentType];
    if (!ext) {
      return errorResponse("Extensão inválida", 400);
    }

    const assetType = payload.assetType === "avatar"
      ? "avatar"
      : payload.assetType === "report"
        ? "report"
        : "listing";
    const bucket = assetType === "avatar" ? R2_PROFILE_BUCKET : R2_BUCKET;
    if (!bucket) {
      return errorResponse("Bucket R2 não configurado", 500);
    }

    const keyPrefix = assetType === "avatar"
      ? `avatars/${authData.user.id}`
      : assetType === "report"
        ? `reports/${authData.user.id}`
        : `listings/${authData.user.id}`;
    const key = `${keyPrefix}/${crypto.randomUUID()}.${ext}`;
    const endpoint = R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const endpointUrl = new URL(endpoint);
    const host = endpointUrl.host;
    const canonicalUri = `/${bucket}/${key.split("/").map(encodeRFC3986).join("/")}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const region = "auto";
    const service = "s3";
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const signedHeaders = "content-type;host";

    const queryParams: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${R2_ACCESS_KEY_ID}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": "600",
      "X-Amz-SignedHeaders": signedHeaders,
    };

    const canonicalQuery = buildCanonicalQuery(queryParams);
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
    const payloadHash = "UNSIGNED-PAYLOAD";
    const canonicalRequest = [
      "PUT",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const hashedRequest = await sha256Hex(canonicalRequest);
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      hashedRequest,
    ].join("\n");

    const signingKey = await getSignatureKey(R2_SECRET_ACCESS_KEY, dateStamp, region, service);
    const signatureBytes = await hmacSha256(signingKey, stringToSign);
    const signature = toHex(signatureBytes.buffer);

    const uploadUrl = `${endpointUrl.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    let publicBase = (
      assetType === "avatar" ? (R2_PROFILE_PUBLIC_URL || "") : (R2_PUBLIC_URL || "")
    ).replace(/\/$/, "");
    if (publicBase.includes("r2.cloudflarestorage.com")) {
      publicBase = `https://${bucket}.${R2_ACCOUNT_ID}.r2.dev`;
    }
    if (!publicBase) {
      publicBase = `https://${bucket}.${R2_ACCOUNT_ID}.r2.dev`;
    }
    const publicUrl = `${publicBase}/${key}`;

    return new Response(
      JSON.stringify({
        ok: true,
        uploadUrl,
        publicUrl,
        key,
        expiresIn: 600,
      }),
      {
        headers: { "content-type": "application/json", ...corsHeaders },
      }
    );
  } catch (err) {
    console.error(err);
    return errorResponse("Erro ao gerar URL de upload", 500);
  }
});
