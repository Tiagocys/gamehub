import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function loadEnv(envPath) {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function encodePath(pathname) {
  return pathname
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function encodeRFC3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmacSha256(key, data, encoding = undefined) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(encoding);
}

function sha256HexBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function extractSupabaseLogoPath(input) {
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

async function supabaseGet(resource) {
  const response = await fetch(`${stripTrailingSlash(process.env.PROJECT_URL)}${resource}`, {
    headers: {
      apikey: process.env.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao buscar ${resource} (${response.status}): ${body}`);
  }
  return response.json();
}

async function supabasePatch(resource, payload) {
  const response = await fetch(`${stripTrailingSlash(process.env.PROJECT_URL)}${resource}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      apikey: process.env.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao atualizar ${resource} (${response.status}): ${body}`);
  }
}

async function downloadSupabaseObject(objectPath) {
  const encodedPath = encodePath(objectPath);
  const url = `${stripTrailingSlash(process.env.PROJECT_URL)}/storage/v1/object/authenticated/server_logos/${encodedPath}`;
  const response = await fetch(url, {
    headers: {
      apikey: process.env.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha ao baixar logo ${objectPath} (${response.status}): ${body}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadToR2(key, body, contentType = "image/webp") {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "img-anuncios";
  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("Variáveis R2 insuficientes para a migração.");
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
  const signedHeaders = "content-type;host";
  const payloadHash = sha256HexBuffer(body);
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    `content-type:${contentType}\nhost:${host}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256HexBuffer(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = hmacSha256(signingKey, stringToSign, "hex");
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  const response = await fetch(`${endpointUrl.origin}${canonicalUri}`, {
    method: "PUT",
    headers: {
      Host: host,
      "Content-Type": contentType,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization,
    },
    body,
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Falha ao enviar para R2 (${response.status}): ${bodyText}`);
  }
}

function buildLogoPublicUrl(key) {
  const bucket = process.env.R2_BUCKET || "img-anuncios";
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const publicBase = stripTrailingSlash(process.env.R2_PUBLIC_URL) || `https://${bucket}.${accountId}.r2.dev`;
  return `${publicBase}/${key}`;
}

function mapOldPathToNewKey(oldPath) {
  const normalized = oldPath.replace(/^\/+/, "");
  const logoPrefix = (process.env.R2_LOGO_PREFIX || "logos").replace(/^\/+|\/+$/g, "");
  return normalized.startsWith(`${logoPrefix}/`) ? normalized : `${logoPrefix}/${normalized}`;
}

async function main() {
  loadEnv(path.resolve(process.cwd(), ".env"));
  const projectUrl = process.env.PROJECT_URL || "";
  const serviceKey = process.env.SERVICE_ROLE_KEY || "";
  if (!projectUrl || !serviceKey) {
    throw new Error("PROJECT_URL e SERVICE_ROLE_KEY são obrigatórios.");
  }

  const [servers, requests] = await Promise.all([
    supabaseGet("/rest/v1/servers?select=id,banner_url&not.banner_url=is.null"),
    supabaseGet("/rest/v1/game_requests?select=id,cover_url&not.cover_url=is.null"),
  ]);

  const references = new Map();
  for (const row of servers) {
    const oldPath = extractSupabaseLogoPath(row.banner_url);
    if (oldPath) references.set(oldPath, { kind: "servers", rows: [...(references.get(oldPath)?.rows || []), row] });
  }
  for (const row of requests) {
    const oldPath = extractSupabaseLogoPath(row.cover_url);
    if (oldPath) references.set(oldPath, { kind: "mixed", rows: [...(references.get(oldPath)?.rows || []), row] });
  }

  if (references.size === 0) {
    console.log("Nenhuma logo do Supabase Storage encontrada para migrar.");
    return;
  }

  let migrated = 0;
  for (const [oldPath] of references) {
    const source = await downloadSupabaseObject(oldPath);
    const newKey = mapOldPathToNewKey(oldPath);
    await uploadToR2(newKey, source);
    const newUrl = buildLogoPublicUrl(newKey);

    for (const row of servers.filter((item) => extractSupabaseLogoPath(item.banner_url) === oldPath)) {
      await supabasePatch(`/rest/v1/servers?id=eq.${encodeURIComponent(row.id)}`, { banner_url: newUrl });
    }
    for (const row of requests.filter((item) => extractSupabaseLogoPath(item.cover_url) === oldPath)) {
      await supabasePatch(`/rest/v1/game_requests?id=eq.${encodeURIComponent(row.id)}`, { cover_url: newUrl });
    }

    migrated += 1;
    console.log(`Migrada: ${oldPath} -> ${newUrl}`);
  }

  console.log(`Migração concluída. ${migrated} logo(s) atualizadas para o prefixo "${process.env.R2_LOGO_PREFIX || "logos"}" no bucket "${process.env.R2_BUCKET || "img-anuncios"}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
