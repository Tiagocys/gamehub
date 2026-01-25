import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.40.0";

type Payload = {
  contentType?: string;
  extension?: string;
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
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
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

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return errorResponse("Variáveis PROJECT_URL ou SERVICE_ROLE_KEY ausentes", 500);
    }
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
      return errorResponse("Variáveis R2 não configuradas", 500);
    }
    if (!R2_PUBLIC_URL && (!R2_BUCKET || !R2_ACCOUNT_ID)) {
      return errorResponse("R2_PUBLIC_URL não configurada", 500);
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

    const key = `listings/${authData.user.id}/${crypto.randomUUID()}.${ext}`;
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
    let publicBase = (R2_PUBLIC_URL || "").replace(/\/$/, "");
    if (publicBase.includes("r2.cloudflarestorage.com")) {
      publicBase = `https://${R2_BUCKET}.${R2_ACCOUNT_ID}.r2.dev`;
    }
    if (!publicBase) {
      publicBase = `https://${R2_BUCKET}.${R2_ACCOUNT_ID}.r2.dev`;
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
