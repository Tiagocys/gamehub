const textEncoder = new TextEncoder();

export function getLogoR2Config() {
  const accountId = Deno.env.get("R2_ACCOUNT_ID") || "";
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") || "";
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
  const endpoint = Deno.env.get("R2_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`;
  const bucket = Deno.env.get("R2_BUCKET") || "";
  const publicUrl = Deno.env.get("R2_PUBLIC_URL") || "";
  const prefix = (Deno.env.get("R2_LOGO_PREFIX") || "logos").replace(/^\/+|\/+$/g, "");
  return { accountId, accessKeyId, secretAccessKey, endpoint, bucket, publicUrl, prefix };
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
  return await hmacSha256(kService, "aws4_request");
}

function buildCanonicalQuery(params: Record<string, string>) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeRFC3986(key)}=${encodeRFC3986(params[key])}`)
    .join("&");
}

export function extractSupabaseLogoPath(input: string | null | undefined) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    return raw.replace(/^\/+/, "");
  }
  try {
    const parsed = new URL(raw);
    const marker = "/server_logos/";
    const idx = parsed.pathname.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(parsed.pathname.substring(idx + marker.length));
  } catch (_err) {
    return null;
  }
}

export function extractLogoR2Key(input: string | null | undefined) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  const { accountId, bucket, publicUrl, prefix } = getLogoR2Config();
  const logoPrefix = `${prefix}/`;

  if (!/^https?:\/\//i.test(raw)) {
    const normalized = raw.replace(/^\/+/, "");
    if (normalized.startsWith(logoPrefix)) return normalized;
    return null;
  }

  try {
    const url = new URL(raw);
    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!path) return null;

    if (publicUrl) {
      try {
        const publicHost = new URL(publicUrl).host;
        if (url.host === publicHost && path.startsWith(logoPrefix)) return path;
      } catch (_err) {
        // ignore malformed configured public URL
      }
    }

    if (bucket && path.startsWith(`${bucket}/${logoPrefix}`)) {
      return path.slice(bucket.length + 1);
    }

    if (url.host.includes(".r2.cloudflarestorage.com") && bucket) {
      const marker = `/${bucket}/`;
      const idx = url.pathname.indexOf(marker);
      if (idx >= 0) {
        const key = decodeURIComponent(url.pathname.slice(idx + marker.length));
        if (key.startsWith(logoPrefix)) return key;
      }
    }

    const expectedR2DevHost = bucket && accountId ? `${bucket}.${accountId}.r2.dev` : "";
    if (url.host.endsWith(".r2.dev")) {
      if (!expectedR2DevHost || url.host === expectedR2DevHost) {
        if (path.startsWith(logoPrefix)) return path;
      }
    }
  } catch (_err) {
    return null;
  }

  return null;
}

export async function deleteLogoFromR2(key: string) {
  const { accountId, accessKeyId, secretAccessKey, endpoint, bucket } = getLogoR2Config();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("Variáveis R2 de logos não configuradas");
  }

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
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
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

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signatureBytes = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBytes.buffer);
  const url = `${endpointUrl.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;

  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao excluir logo no R2 (${response.status}): ${body}`);
  }
}
