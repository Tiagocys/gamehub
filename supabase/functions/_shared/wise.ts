const DEFAULT_SOURCE_CURRENCY = "GBP";
const DEFAULT_REQUIREMENTS_SOURCE_AMOUNT = 10;
const DEFAULT_WISE_SANDBOX_API_BASE = "https://api.sandbox.transferwise.tech";
const DEFAULT_WISE_PRODUCTION_API_BASE = "https://api.transferwise.com";

export class WiseAppError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WiseAppError";
    this.status = status;
  }
}

export function getWiseApiBase() {
  const explicitBase = String(Deno.env.get("WISE_API_BASE") || "").trim().replace(/\/+$/, "");
  if (explicitBase) return explicitBase;
  const hasProductionToken = Boolean(
    String(Deno.env.get("WISE_API") || Deno.env.get("WISE_API_KEY") || "").trim(),
  );
  return hasProductionToken ? DEFAULT_WISE_PRODUCTION_API_BASE : DEFAULT_WISE_SANDBOX_API_BASE;
}

export function getWiseToken() {
  const token = String(
    Deno.env.get("WISE_API")
      || Deno.env.get("WISE_API_KEY")
      || Deno.env.get("WISE_API_SANDBOX")
      || "",
  ).trim();
  if (!token) {
    throw new WiseAppError("WISE_API, WISE_API_KEY ou WISE_API_SANDBOX não configurado", 500);
  }
  return token;
}

export function getWiseSourceCurrency() {
  const value = String(Deno.env.get("WISE_SOURCE_CURRENCY") || DEFAULT_SOURCE_CURRENCY).trim().toUpperCase();
  return value || DEFAULT_SOURCE_CURRENCY;
}

export function getWiseProfileId() {
  const raw = String(Deno.env.get("WISE_PROFILE_ID") || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getRequirementsSourceAmount() {
  const parsed = Number(Deno.env.get("WISE_REQUIREMENTS_SOURCE_AMOUNT") || DEFAULT_REQUIREMENTS_SOURCE_AMOUNT);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUIREMENTS_SOURCE_AMOUNT;
}

export function normalizeCountryCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeCurrencyCode(value: unknown) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeLegalType(value: unknown) {
  return String(value || "").trim().toUpperCase() === "BUSINESS" ? "BUSINESS" : "PRIVATE";
}

function roundMoney(value: unknown, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** decimals;
  return Math.round(parsed * factor) / factor;
}

export async function wiseRequest(path: string, options: {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
} = {}) {
  const token = options.token || getWiseToken();
  const response = await fetch(`${getWiseApiBase()}${path}`, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || payload?.message || payload?.errors?.[0]?.message || `Falha na Wise (${response.status})`;
    throw new WiseAppError(String(message), response.status);
  }
  return payload;
}

export async function getWiseProfiles(token?: string) {
  const profiles = await wiseRequest("/v2/profiles", { token });
  return Array.isArray(profiles) ? profiles : [];
}

export async function getPrimaryWiseProfile(token?: string) {
  const profiles = await getWiseProfiles(token);
  const configuredProfileId = getWiseProfileId();
  if (configuredProfileId) {
    const configuredProfile = profiles.find((item) => Number(item?.id) === configuredProfileId);
    if (configuredProfile) {
      return configuredProfile;
    }
  }
  const profile = profiles.find((item) => String(item?.type || "").toLowerCase() === "business")
    || profiles.find((item) => item?.id)
    || null;
  if (!profile?.id) {
    throw new WiseAppError("Nenhum profile Wise disponível para esta conta.", 409);
  }
  return profile;
}

export async function createRequirementsQuote(params: {
  profileId: number | string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount?: number;
  token?: string;
}) {
  return await wiseRequest(`/v3/profiles/${encodeURIComponent(String(params.profileId))}/quotes`, {
    method: "POST",
    token: params.token,
    body: {
      sourceCurrency: params.sourceCurrency,
      targetCurrency: params.targetCurrency,
      sourceAmount: params.sourceAmount || getRequirementsSourceAmount(),
      targetAmount: null,
      payOut: null,
      preferredPayIn: null,
    },
  });
}

export async function createTransferQuote(params: {
  profileId: number | string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount?: number;
  targetAmount?: number;
  targetAccount?: number | string | null;
  token?: string;
  locale?: string;
}) {
  const body: Record<string, unknown> = {
    sourceCurrency: normalizeCurrencyCode(params.sourceCurrency),
    targetCurrency: normalizeCurrencyCode(params.targetCurrency),
    sourceAmount: null,
    targetAmount: null,
    preferredPayIn: "BALANCE",
    payOut: null,
  };
  const normalizedSourceAmount = roundMoney(params.sourceAmount);
  const normalizedTargetAmount = roundMoney(params.targetAmount);
  if (normalizedSourceAmount > 0) {
    body.sourceAmount = normalizedSourceAmount;
  } else if (normalizedTargetAmount > 0) {
    body.targetAmount = normalizedTargetAmount;
  } else {
    throw new WiseAppError("Informe sourceAmount ou targetAmount para gerar a quote.", 400);
  }
  if (params.targetAccount) {
    body.targetAccount = Number(params.targetAccount);
  }

  return await wiseRequest(`/v3/profiles/${encodeURIComponent(String(params.profileId))}/quotes`, {
    method: "POST",
    token: params.token,
    headers: params.locale ? { "Accept-Language": params.locale } : undefined,
    body,
  });
}

export async function fetchRecipientRequirements(params: {
  countryCode?: string;
  targetCurrency?: string;
  quoteId: string | number;
  legalType: string;
  recipientPayload?: Record<string, unknown> | null;
  token?: string;
  locale?: string;
}) {
  if (params.countryCode && params.targetCurrency) {
    const query = new URLSearchParams({
      source: params.targetCurrency,
      target: params.targetCurrency,
      sourceAmount: "1",
      targetCountry: params.countryCode,
    });
    return await wiseRequest(`/v1/account-requirements?${query.toString()}`, {
      method: "GET",
      token: params.token,
      headers: params.locale ? { "Accept-Language": params.locale } : undefined,
    });
  }
  const query = new URLSearchParams({
    originatorLegalEntityType: params.legalType,
    addressRequired: "true",
  });
  const path = `/v1/quotes/${encodeURIComponent(String(params.quoteId))}/account-requirements?${query.toString()}`;
  if (params.recipientPayload && Object.keys(params.recipientPayload).length > 0) {
    return await wiseRequest(path, {
      method: "POST",
      token: params.token,
      headers: { "Accept-Minor-Version": "1" },
      body: params.recipientPayload,
    });
  }
  return await wiseRequest(path, {
    method: "GET",
    token: params.token,
    headers: { "Accept-Minor-Version": "1" },
  });
}

export async function createRecipientAccount(params: {
  profileId: number | string;
  countryCode: string;
  accountHolderName: string;
  targetCurrency: string;
  recipientPayload: Record<string, unknown>;
  token?: string;
}) {
  const rawPayload = params.recipientPayload && typeof params.recipientPayload === "object"
    ? params.recipientPayload
    : {};
  const type = String((rawPayload as Record<string, unknown>).type || "").trim();
  const rawDetails = rawPayload && typeof (rawPayload as Record<string, unknown>).details === "object"
    ? { ...((rawPayload as Record<string, unknown>).details as Record<string, unknown>) }
    : {};

  Object.entries(rawPayload as Record<string, unknown>).forEach(([key, value]) => {
    if (key === "type" || key === "details") return;
    rawDetails[key] = value;
  });

  const payload = {
    profile: params.profileId,
    accountHolderName: params.accountHolderName,
    currency: params.targetCurrency,
    country: params.countryCode,
    type,
    details: rawDetails,
  };
  return await wiseRequest("/v1/accounts", {
    method: "POST",
    token: params.token,
    body: payload,
  });
}

export async function getRecipientAccount(accountId: string | number, token?: string) {
  return await wiseRequest(`/v2/accounts/${encodeURIComponent(String(accountId))}`, {
    method: "GET",
    token,
  });
}

export function extractQuoteFinancials(quote: Record<string, unknown> | null | undefined) {
  const paymentOptions = Array.isArray(quote?.paymentOptions)
    ? quote.paymentOptions.filter((item: any) => !item?.disabled)
    : [];
  const option = paymentOptions[0] || (Array.isArray(quote?.paymentOptions) ? quote.paymentOptions[0] : null) || null;
  const feeTotal = option?.fee?.total ?? option?.price?.total?.value?.amount ?? 0;
  const feeCurrency = option?.price?.total?.value?.currency || quote?.sourceCurrency || null;

  return {
    quoteId: String(quote?.id || "").trim() || null,
    sourceCurrency: normalizeCurrencyCode(quote?.sourceCurrency),
    targetCurrency: normalizeCurrencyCode(quote?.targetCurrency),
    sourceAmount: roundMoney(quote?.sourceAmount),
    targetAmount: roundMoney(quote?.targetAmount),
    rate: Number(quote?.rate || 0) || 0,
    feeAmount: roundMoney(feeTotal),
    feeCurrency: feeCurrency ? normalizeCurrencyCode(feeCurrency) : null,
  };
}

export async function createTransfer(params: {
  targetAccount: number | string;
  quoteId: string;
  customerTransactionId: string;
  reference: string;
  token?: string;
}) {
  return await wiseRequest("/v1/transfers", {
    method: "POST",
    token: params.token,
    body: {
      targetAccount: Number(params.targetAccount),
      quoteUuid: params.quoteId,
      customerTransactionId: params.customerTransactionId,
      details: {
        reference: params.reference,
      },
    },
  });
}

export async function getTransfer(transferId: string | number, token?: string) {
  return await wiseRequest(`/v1/transfers/${encodeURIComponent(String(transferId))}`, {
    method: "GET",
    token,
  });
}

export async function cancelTransfer(transferId: string | number, token?: string) {
  return await wiseRequest(`/v1/transfers/${encodeURIComponent(String(transferId))}/cancel`, {
    method: "PUT",
    token,
  });
}

export function buildWiseTransferReference(id: string) {
  const suffix = String(id || "").replace(/[^a-z0-9]/gi, "").slice(0, 12).toUpperCase();
  return `GIMERR ${suffix}`.trim().slice(0, 35);
}

export function mapWiseTransferStateToRequestStatus(state: unknown) {
  const normalized = String(state || "").trim().toLowerCase();
  if (!normalized) return "pending";
  if ([
    "processing",
    "funds_converted",
  ].includes(normalized)) {
    return "approved";
  }
  if ([
    "outgoing_payment_sent",
    "completed",
  ].includes(normalized)) {
    return "paid";
  }
  if ([
    "cancelled",
    "canceled",
    "funds_refunded",
  ].includes(normalized)) {
    return "cancelled";
  }
  if ([
    "bounced_back",
    "charged_back",
    "unknown",
    "error",
  ].includes(normalized)) {
    return "failed";
  }
  return "pending";
}

export function buildAccountSummary(account: Record<string, unknown> | null | undefined) {
  if (!account || typeof account !== "object") {
    return {
      accountSummary: "",
      longAccountSummary: "",
      displayFields: [],
    };
  }

  const accountSummary = String(account.accountSummary || "").trim();
  const longAccountSummary = String(account.longAccountSummary || accountSummary || "").trim();
  const displayFields = Array.isArray(account.displayFields)
    ? account.displayFields.map((item) => ({
        key: String(item?.key || ""),
        label: String(item?.label || item?.key || ""),
        value: String(item?.value || ""),
      })).filter((item) => item.key && item.value)
    : [];

  return {
    accountSummary,
    longAccountSummary,
    displayFields,
  };
}
