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

function encodeRFC3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function hmacSha256(key, data, encoding = undefined) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(encoding);
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

async function createBucket(bucket) {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const endpoint = process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY são obrigatórios.");
  }

  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const canonicalUri = `/${encodeRFC3986(bucket)}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = "host";
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    `host:${host}\n`,
    signedHeaders,
    sha256Hex(""),
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
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
      "x-amz-date": amzDate,
      "x-amz-content-sha256": sha256Hex(""),
      Authorization: authorization,
    },
  });

  if (response.ok || response.status === 409) {
    console.log(response.status === 409 ? `Bucket "${bucket}" já existe.` : `Bucket "${bucket}" criado.`);
    return;
  }

  const body = await response.text().catch(() => "");
  throw new Error(`Falha ao criar bucket (${response.status}): ${body}`);
}

loadEnv(path.resolve(process.cwd(), ".env"));
const bucket = process.argv[2] || process.env.R2_LOGO_BUCKET || "logos";
createBucket(bucket).catch((err) => {
  console.error(err);
  process.exit(1);
});
