(() => {
  const i18n = window.__I18N__ || { t: (_key, fallback = "") => fallback };
  const t = (key, fallback = "") => i18n.t(key, fallback);
  let authClientPromise = null;
  let profileSyncBootstrapped = false;
  let discordOnboardingBootstrapped = false;
  let discordOnboardingModalRefs = null;
  const DISCORD_OAUTH_CONTEXT_KEY = "gimerr-discord-oauth-context";
  const AUTH_PROVIDER_HINT_KEY = "gimerr-auth-provider-hint";
  const AUTH_STORAGE_KEY = "gimerr-auth-token";
  const LEGACY_AUTH_STORAGE_KEY = "gimerr-auth-session";
  const PARTNER_BOT_SETUP_STORAGE_KEY = "gimerr-partner-bot-setup-server-id";
  let partnerAccessCache = {
    userId: null,
    canAccess: false,
  };
  const DISCORD_ONBOARDING_PENDING_KEY = "gimerr-discord-onboarding-pending";
  const DISCORD_ONBOARDING_SEEN_PREFIX = "gimerr-discord-onboarding-seen:v1:";

  function isDeletedAccountProfileError(error) {
    const code = String(error?.code || "").trim();
    const message = String(error?.message || "").trim().toLowerCase();
    const details = String(error?.details || "").trim().toLowerCase();
    return code === "23503"
      || message.includes("users_id_fkey")
      || details.includes("users_id_fkey")
      || (message.includes("foreign key") && message.includes("users"));
  }

  async function clearLocalAuthState(client = null) {
    try {
      if (client?.auth?.signOut) {
        await client.auth.signOut({ scope: "local" });
      }
    } catch (_err) {
      // Ignore local sign-out failures and clear storage manually below.
    }
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
      localStorage.removeItem(AUTH_PROVIDER_HINT_KEY);
      localStorage.removeItem(DISCORD_OAUTH_CONTEXT_KEY);
    } catch (_err) {
      // Ignore storage failures.
    }
    try {
      sessionStorage.removeItem(DISCORD_ONBOARDING_PENDING_KEY);
      sessionStorage.removeItem("gimerr-password-recovery");
      sessionStorage.removeItem("gimerr-post-discord-link");
    } catch (_err) {
      // Ignore storage failures.
    }
    authClientPromise = null;
    profileSyncBootstrapped = false;
    discordOnboardingBootstrapped = false;
    partnerAccessCache = { userId: null, canAccess: false };
  }

  async function handleDeletedAccountSession(client, error) {
    console.warn("Sessão local removida após detectar conta excluída.", error);
    await clearLocalAuthState(client);
    const path = String(window.location.pathname || "").toLowerCase();
    if (path.endsWith("/sign-in.html") || path === "/sign-in.html") return;
    window.location.replace("index.html");
  }

  function isInvalidRemoteSessionError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? 0);
    const code = String(error?.code || "").trim().toLowerCase();
    const message = String(error?.message || "").trim().toLowerCase();
    if ([400, 401, 403].includes(status)) return true;
    if (["session_not_found", "user_not_found", "invalid_jwt"].includes(code)) return true;
    return message.includes("user not found")
      || message.includes("session not found")
      || message.includes("jwt")
      || message.includes("invalid claim")
      || message.includes("forbidden")
      || message.includes("unauthorized");
  }

  async function validateRemoteSession(client, session) {
    const token = String(session?.access_token || "").trim();
    if (!token) return session || null;
    try {
      const { data, error } = await client.auth.getUser(token);
      if (error) {
        if (isInvalidRemoteSessionError(error)) {
          await handleDeletedAccountSession(client, error);
          return null;
        }
        console.warn("Falha ao validar sessão remota do usuário:", error);
        return session || null;
      }
      if (!data?.user?.id) {
        await handleDeletedAccountSession(client, { message: "User not found in remote auth session." });
        return null;
      }
      return session || null;
    } catch (error) {
      if (isInvalidRemoteSessionError(error)) {
        await handleDeletedAccountSession(client, error);
        return null;
      }
      console.warn("Falha ao validar sessão remota do usuário:", error);
      return session || null;
    }
  }

  function persistDiscordOAuthContext(session) {
    try {
      if (!session?.user?.id) {
        localStorage.removeItem(DISCORD_OAUTH_CONTEXT_KEY);
        return;
      }
      const currentProvider = String(session?.user?.app_metadata?.provider || "").trim().toLowerCase();
      if (currentProvider && currentProvider !== "discord") {
        localStorage.removeItem(DISCORD_OAUTH_CONTEXT_KEY);
        return;
      }
      const providerToken = String(session?.provider_token || "").trim();
      if (!providerToken) return;
      localStorage.setItem(DISCORD_OAUTH_CONTEXT_KEY, JSON.stringify({
        user_id: String(session.user.id),
        provider_token: providerToken,
        saved_at: Date.now(),
      }));
    } catch (_err) {
      // Ignore localStorage persistence failures.
    }
  }

  function persistAuthProviderHint(session) {
    try {
      if (!session?.user?.id) return;
      const provider = String(session?.user?.app_metadata?.provider || "").trim().toLowerCase();
      if (!provider) return;
      localStorage.setItem(AUTH_PROVIDER_HINT_KEY, JSON.stringify({
        provider,
        user_id: String(session.user.id),
        saved_at: Date.now(),
      }));
    } catch (_err) {
      // Ignore localStorage persistence failures.
    }
  }

  function normalizeUsername(value) {
    const clean = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 32);
    return clean || "user";
  }

  function normalizeProfileUsername(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 20);
  }

  function validateProfileUsername(value) {
    return /^[a-z0-9]{3,20}$/.test(String(value || ""));
  }

  function isLikelyProviderId(value) {
    return /^[0-9]{8,}$/.test(String(value || "").trim());
  }

  function pickFirstUsefulValue(values) {
    for (const value of values || []) {
      const text = String(value || "").trim();
      if (!text || isLikelyProviderId(text)) continue;
      return text;
    }
    return "";
  }

  function pickFirstPresentValue(values) {
    for (const value of values || []) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function shouldReplaceStoredValue(currentValue, incomingValue, fallbacks = []) {
    const current = String(currentValue || "").trim();
    const incoming = String(incomingValue || "").trim();
    if (!incoming) return current || null;
    if (!current) return incoming;
    const currentKey = current.toLowerCase();
    const fallbackKeys = new Set(
      (Array.isArray(fallbacks) ? fallbacks : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    );
    if (isLikelyProviderId(current) || fallbackKeys.has(currentKey)) return incoming;
    return current;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function matchesPrefix(value, term) {
    const normalizedValue = normalizeSearchText(value);
    const normalizedTerm = normalizeSearchText(term);
    if (!normalizedValue || !normalizedTerm) return false;
    if (normalizedValue.startsWith(normalizedTerm)) return true;
    return normalizedValue.split(/\s+/).some((part) => part.startsWith(normalizedTerm));
  }

  function formatPlayerName(user) {
    const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
    if (fullName) return fullName;
    const username = String(user?.username || "").trim();
    if (username) return username;
    const email = String(user?.email || "").trim();
    return email ? email.split("@")[0] : "Player";
  }

  function hasSearchableListingProfile(user) {
    const discordId = String(user?.discord_id || "").trim();
    return /^[0-9]{17,20}$/.test(discordId);
  }

  function isHomePage() {
    const path = window.location.pathname || "/";
    return path === "/" || path.endsWith("/index.html");
  }

  function buildSearchablePlayer(user) {
    const displayName = formatPlayerName(user);
    const username = String(user?.username || "").trim();
    const nameParts = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
    const searchTerms = [username, displayName, nameParts].filter(Boolean);
    return {
      id: user.id,
      username,
      name: displayName,
      avatar_url: user.avatar_url || "img/avatar.svg",
      searchTerms,
      searchText: normalizeSearchText(searchTerms.join(" ")),
    };
  }

  function getPublicEnv() {
    const env = window.__ENV || {};
    const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const anonKey = String(env.SUPABASE_ANON_KEY || "").trim();
    if (!url || !anonKey || url.startsWith("YOUR_") || anonKey.startsWith("YOUR_")) {
      throw new Error("Supabase não configurado.");
    }
    return { url, anonKey };
  }

  function parseStoragePath(rawUrl) {
    try {
      const { url } = getPublicEnv();
      const origin = new URL(url).origin;
      const parsed = new URL(rawUrl, window.location.origin);
      if (parsed.origin !== origin) return null;
      const marker = "/storage/v1/object/";
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex === -1) return null;
      const rawPath = parsed.pathname.slice(markerIndex + marker.length);
      const parts = rawPath.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      let bucket = parts[0];
      let pathParts = parts.slice(1);
      if (bucket === "public" || bucket === "authenticated" || bucket === "sign") {
        bucket = parts[1];
        pathParts = parts.slice(2);
      }
      if (!bucket || pathParts.length === 0) return null;
      return { bucket, path: pathParts.join("/") };
    } catch (_err) {
      return null;
    }
  }

  function normalizeR2PublicUrl(urlString) {
    const env = window.__ENV || {};
    const r2PublicUrl = String(env.R2_PUBLIC_URL || "").trim();
    const r2Bucket = String(env.R2_BUCKET || "").trim();
    try {
      const url = new URL(urlString);
      if (r2PublicUrl) {
        const publicHost = new URL(r2PublicUrl).host;
        const accountId = url.hostname.split(".")[1] || "";
        const expectedBucketHost = r2Bucket && accountId ? `${r2Bucket}.${accountId}.r2.dev` : "";
        if (url.hostname === expectedBucketHost && url.hostname !== publicHost) {
          return `${r2PublicUrl.replace(/\/$/, "")}${url.pathname}`;
        }
      }
      if (!url.hostname.endsWith(".r2.cloudflarestorage.com")) return urlString;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 0) return urlString;
      const accountId = url.hostname.split(".")[0];
      let bucket = r2Bucket;
      let keyParts = parts;
      if (bucket) {
        if (parts[0] === bucket) keyParts = parts.slice(1);
      } else {
        bucket = parts[0];
        keyParts = parts.slice(1);
      }
      if (!bucket || keyParts.length === 0) return urlString;
      const base = r2PublicUrl ? r2PublicUrl.replace(/\/$/, "") : `https://${bucket}.${accountId}.r2.dev`;
      return `${base}/${keyParts.join("/")}`;
    } catch (_err) {
      return urlString;
    }
  }

  async function resolveSearchImageUrl(urlString) {
    if (!urlString) return "";
    const normalized = normalizeR2PublicUrl(urlString);
    const parsed = parseStoragePath(normalized);
    if (!parsed) return normalized;
    try {
      const client = await getAuthClient();
      const { data, error } = await client.storage.from(parsed.bucket).createSignedUrl(parsed.path, 60 * 60 * 6);
      if (error) throw error;
      return data?.signedUrl || normalized;
    } catch (_err) {
      return normalized;
    }
  }

  async function fetchSupabaseRows(path, params) {
    const { url, anonKey } = getPublicEnv();
    const endpoint = new URL(`${url}/rest/v1/${path}`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") return;
      endpoint.searchParams.set(key, value);
    });
    const response = await fetch(endpoint.toString(), {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `Falha ao consultar ${path}.`);
    }
    return response.json();
  }

  function parseUserName(user) {
    if (isDiscordAuthUser(user)) {
      return { first_name: null, last_name: null };
    }
    const meta = user?.user_metadata || {};
    const given = pickFirstUsefulValue([
      meta.given_name,
      meta.first_name,
    ]);
    if (given) {
      return { first_name: given || null, last_name: null };
    }
    const full = pickFirstUsefulValue([
      meta.full_name,
      meta.name,
    ]);
    if (!full) return { first_name: null, last_name: null };
    const parts = full.split(/\s+/);
    if (parts.length === 1) return { first_name: parts[0], last_name: null };
    return { first_name: parts[0], last_name: null };
  }

  function getIdentityData(user, provider) {
    const identities = Array.isArray(user?.identities) ? user.identities : [];
    const identity = identities.find((item) => String(item?.provider || "").toLowerCase() === String(provider || "").toLowerCase());
    return identity?.identity_data || {};
  }

  function isDiscordAuthUser(user) {
    const appMetaProvider = String(user?.app_metadata?.provider || "").trim().toLowerCase();
    if (appMetaProvider === "discord") return true;
    const identities = Array.isArray(user?.identities) ? user.identities : [];
    return identities.some((item) => String(item?.provider || "").trim().toLowerCase() === "discord");
  }

  function isDiscordAuthSession(session) {
    const provider = String(session?.user?.app_metadata?.provider || "").trim().toLowerCase();
    if (provider === "discord") return true;
    const providerHint = String(session?.user?.user_metadata?.provider || "").trim().toLowerCase();
    return providerHint === "discord";
  }

  function hasLinkedDiscordIdentity(user) {
    const identities = Array.isArray(user?.identities) ? user.identities : [];
    if (identities.some((item) => String(item?.provider || "").trim().toLowerCase() === "discord")) {
      return true;
    }
    const providers = Array.isArray(user?.app_metadata?.providers) ? user.app_metadata.providers : [];
    return providers.some((item) => String(item || "").trim().toLowerCase() === "discord");
  }

  function normalizeDiscordUsername(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/#\d{1,4}$/, "")
      .replace(/[^a-z0-9._]/g, "")
      .replace(/\.{2,}/g, ".")
      .slice(0, 32);
  }

  function extractDiscordHandle(user) {
    const discordMeta = getIdentityData(user, "discord");
    const meta = user?.user_metadata || {};
    const candidates = [
      discordMeta.username,
      discordMeta.user_name,
      discordMeta.preferred_username,
      discordMeta.name,
      meta.username,
      meta.user_name,
      meta.preferred_username,
      meta.name,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeDiscordUsername(candidate || "");
      if (normalized) return normalized;
    }
    return "";
  }

  function buildInternalUsernameFromDiscordHandle(handle) {
    const normalized = normalizeProfileUsername(String(handle || "").replace(/[._]/g, ""));
    return validateProfileUsername(normalized) ? normalized : "";
  }

  function extractDiscordId(user) {
    const discordMeta = getIdentityData(user, "discord");
    const meta = user?.user_metadata || {};
    const candidates = [
      discordMeta.provider_id,
      discordMeta.sub,
      discordMeta.id,
      meta.provider_id,
      meta.sub,
      meta.id,
    ];
    for (const candidate of candidates) {
      const text = String(candidate || "").trim();
      if (/^[0-9]{17,20}$/.test(text)) return text;
    }
    return "";
  }

  function baseUsernameFromUser(user) {
    if (isDiscordAuthUser(user)) {
      const fromDiscordHandle = buildInternalUsernameFromDiscordHandle(extractDiscordHandle(user));
      if (fromDiscordHandle) return fromDiscordHandle;
    }
    const discordMeta = getIdentityData(user, "discord");
    const displayName = pickFirstUsefulValue([
      discordMeta.display_name,
      discordMeta.global_name,
      user?.user_metadata?.full_name,
      user?.user_metadata?.name,
    ]);
    if (displayName) {
      const fromDisplay = normalizeProfileUsername(displayName.split(/\s+/)[0]);
      if (validateProfileUsername(fromDisplay)) return fromDisplay;
    }
    const discordId = pickFirstPresentValue([
      discordMeta.provider_id,
      discordMeta.sub,
      discordMeta.id,
    ]);
    if (discordId) {
      const fromDiscordId = normalizeProfileUsername(discordId);
      if (validateProfileUsername(fromDiscordId)) return fromDiscordId;
    }
    const fromEmail = normalizeProfileUsername(String(user?.email || "").split("@")[0]);
    if (validateProfileUsername(fromEmail)) return fromEmail;
    return normalizeProfileUsername(`user${Math.floor(Math.random() * 900000 + 100000)}`);
  }

  function detectUserLocale() {
    try {
      const forced = String(window.localStorage?.getItem("gimerr-locale-force") || "").trim().toLowerCase();
      if (forced) return forced.startsWith("pt") ? "pt-BR" : "en";
    } catch (_err) {
      // ignore storage failures
    }
    const raw = String((navigator.languages && navigator.languages[0]) || navigator.language || "en").trim().toLowerCase();
    return raw.startsWith("pt") ? "pt-BR" : "en";
  }

  async function ensurePublicUserProfile(client, user) {
    if (!client || !user?.id || !user?.email) return;

    const existing = await client
      .from("users")
      .select("username,first_name,last_name,avatar_url,discord_username,discord_id")
      .eq("id", user.id)
      .maybeSingle();
    if (existing.error && existing.error.code !== "PGRST116") {
      throw existing.error;
    }

    const names = parseUserName(user);
    const discordMeta = getIdentityData(user, "discord");
    const baseUsername = baseUsernameFromUser(user);
    const incomingDiscordUsername = isDiscordAuthUser(user) ? (extractDiscordHandle(user) || null) : null;
    const existingLooksLikeDiscordHandle = isDiscordAuthUser(user)
      && normalizeDiscordUsername(existing.data?.first_name || "") === String(incomingDiscordUsername || "");
    const sanitizedExistingFirstName = existingLooksLikeDiscordHandle || isLikelyProviderId(existing.data?.first_name)
      ? ""
      : String(existing.data?.first_name || "");
    const sanitizedExistingLastName = isLikelyProviderId(existing.data?.last_name)
      ? ""
      : String(existing.data?.last_name || "");
    const resolvedFirstName = pickFirstUsefulValue([sanitizedExistingFirstName, names.first_name]) || null;
    const resolvedLastName = pickFirstUsefulValue([sanitizedExistingLastName, names.last_name]) || null;
    const resolvedDiscordUsername = isDiscordAuthUser(user)
      ? (normalizeDiscordUsername(
          shouldReplaceStoredValue(
            existing.data?.discord_username,
            incomingDiscordUsername,
            [pickFirstPresentValue([existing.data?.discord_username])],
          ) || "",
        ) || null)
      : null;
    const incomingDiscordId = isDiscordAuthUser(user) ? extractDiscordId(user) : "";
    const resolvedDiscordId = isDiscordAuthUser(user) && /^[0-9]{17,20}$/.test(String(incomingDiscordId || "").trim())
      ? String(incomingDiscordId).trim()
      : null;
    const candidates = Array.from(new Set([
      validateProfileUsername(existing.data?.username) && !isLikelyProviderId(existing.data?.username)
        ? existing.data.username
        : "",
      baseUsername,
      normalizeProfileUsername(`${baseUsername}${Math.floor(Math.random() * 900 + 100)}`),
      normalizeProfileUsername(`${baseUsername}${Math.floor(Math.random() * 9000 + 1000)}`),
    ].filter((candidate) => validateProfileUsername(candidate))));

    let lastError = null;
    for (const username of candidates) {
      const payload = {
        id: user.id,
        username,
        email: user.email,
        avatar_url: existing.data?.avatar_url || user.user_metadata?.avatar_url || user.user_metadata?.picture || discordMeta.avatar_url || discordMeta.picture || null,
        first_name: resolvedFirstName,
        last_name: resolvedLastName,
        discord_username: resolvedDiscordUsername,
        discord_id: resolvedDiscordId,
        locale: detectUserLocale(),
      };
      const { error } = await client.from("users").upsert(payload, { onConflict: "id" });
      if (!error) return;
      if (error.code === "23505") {
        lastError = error;
        continue;
      }
      if (isDeletedAccountProfileError(error)) {
        await handleDeletedAccountSession(client, error);
        return;
      }
      throw error;
    }
    if (lastError) throw lastError;
  }

  async function bootstrapProfileSync(client) {
    if (profileSyncBootstrapped) return;
    profileSyncBootstrapped = true;

    client.auth.onAuthStateChange(async (_event, session) => {
      persistAuthProviderHint(session);
      persistDiscordOAuthContext(session);
      if (!session?.user) {
        discordOnboardingBootstrapped = false;
        clearPendingDiscordOnboarding();
        return;
      }
      const validatedSession = await validateRemoteSession(client, session);
      if (!validatedSession?.user) return;
      ensurePublicUserProfile(client, validatedSession.user).catch((err) => {
        console.error("Falha ao sincronizar perfil público:", err);
      });
      maybeOpenDiscordOnboarding(client, validatedSession).catch((err) => {
        console.error("Falha ao abrir onboarding do Discord:", err);
      });
      partnerAccessCache = { userId: null, canAccess: false };
      updatePartnerLinksVisibility(document).catch(() => {});
    });

    const { data } = await client.auth.getSession();
    const validatedSession = await validateRemoteSession(client, data?.session || null);
    persistAuthProviderHint(validatedSession || null);
    persistDiscordOAuthContext(validatedSession || null);
    if (validatedSession?.user) {
      ensurePublicUserProfile(client, validatedSession.user).catch((err) => {
        console.error("Falha ao sincronizar perfil público:", err);
      });
      maybeOpenDiscordOnboarding(client, validatedSession).catch((err) => {
        console.error("Falha ao abrir onboarding do Discord:", err);
      });
      partnerAccessCache = { userId: null, canAccess: false };
      updatePartnerLinksVisibility(document).catch(() => {});
    }
  }

  async function getAuthClient() {
    if (authClientPromise) return authClientPromise;
    authClientPromise = (async () => {
      const env = window.__ENV || {};
      const url = env.SUPABASE_URL || "";
      const anonKey = env.SUPABASE_ANON_KEY || "";
      if (!url || !anonKey || url.startsWith("YOUR_") || anonKey.startsWith("YOUR_")) {
        throw new Error("Supabase não configurado.");
      }
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.40.0");
      const client = createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "gimerr-auth-token",
        },
      });
      await bootstrapProfileSync(client);
      return client;
    })();
    return authClientPromise;
  }

  async function startGoogleLogin() {
    const client = await getAuthClient();
    try {
      localStorage.setItem(AUTH_PROVIDER_HINT_KEY, JSON.stringify({
        provider: "google",
        user_id: "",
        saved_at: Date.now(),
      }));
    } catch (_err) {
      // Ignore localStorage persistence failures.
    }
    const redirectTo = `${window.location.origin}${window.location.pathname}${window.location.search || ""}`;
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) throw error;
  }

  function normalizeGatewayTarget(targetPath = null) {
    const fallback = `${window.location.pathname}${window.location.search || ""}`;
    let normalized = String(targetPath || fallback).trim();
    if (!normalized) return fallback;
    try {
      if (/^https?:\/\//i.test(normalized)) {
        const parsed = new URL(normalized, window.location.origin);
        if (parsed.origin !== window.location.origin) return fallback;
        return `${parsed.pathname}${parsed.search || ""}`;
      }
    } catch (_err) {
      return fallback;
    }
    if (normalized.startsWith("?")) {
      return `${window.location.pathname}${normalized}`;
    }
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  function buildAuthGatewayUrl(targetPath = null) {
    const next = normalizeGatewayTarget(targetPath);
    return `sign-in.html?next=${encodeURIComponent(next)}`;
  }

  window.__OPEN_AUTH_GATEWAY__ = function openAuthGateway(targetPath = null) {
    window.location.href = buildAuthGatewayUrl(targetPath);
  };

  window.__NAVBAR_GOOGLE_LOGIN__ = async function navbarGoogleLogin(_event, buttonEl) {
    try {
      if (buttonEl) buttonEl.disabled = true;
      window.__OPEN_AUTH_GATEWAY__?.();
    } catch (err) {
      console.error(err);
      if (buttonEl) buttonEl.disabled = false;
      alert(err?.message || "Falha no login com Google.");
    }
  };

  async function resolvePartnerAreaAccess() {
    const client = await getAuthClient();
    const { data } = await client.auth.getSession();
    const user = data?.session?.user || null;
    const userId = user?.id || null;
    if (!userId) {
      partnerAccessCache = { userId: null, canAccess: false };
      return false;
    }
    if (partnerAccessCache.userId === userId) {
      return partnerAccessCache.canAccess;
    }
    const canAccess = true;
    partnerAccessCache = { userId, canAccess };
    return canAccess;
  }

  async function updatePartnerLinksVisibility(scope) {
    const canAccess = await resolvePartnerAreaAccess().catch(() => false);
    const nodes = Array.from((scope || document).querySelectorAll("[data-partner-link]"));
    nodes.forEach((node) => {
      node.style.display = canAccess ? "" : "none";
    });
    document.dispatchEvent(new CustomEvent("gimerr:partner-access", { detail: { canAccess } }));
    return canAccess;
  }

  window.__RESOLVE_PARTNER_AREA_ACCESS__ = resolvePartnerAreaAccess;
  window.__UPDATE_PARTNER_LINKS__ = updatePartnerLinksVisibility;

  function hasPendingDiscordOnboarding() {
    try {
      return sessionStorage.getItem(DISCORD_ONBOARDING_PENDING_KEY) === "1";
    } catch (_err) {
      return false;
    }
  }

  function clearPendingDiscordOnboarding() {
    try {
      sessionStorage.removeItem(DISCORD_ONBOARDING_PENDING_KEY);
    } catch (_err) {
      // ignore
    }
  }

  function getDiscordOnboardingSeenKey(userId) {
    const normalizedUserId = String(userId || "").trim();
    return `${DISCORD_ONBOARDING_SEEN_PREFIX}${normalizedUserId || "anonymous"}`;
  }

  function hasSeenDiscordOnboarding(userId) {
    try {
      return localStorage.getItem(getDiscordOnboardingSeenKey(userId)) === "1";
    } catch (_err) {
      return false;
    }
  }

  function markDiscordOnboardingSeen(userId) {
    try {
      localStorage.setItem(getDiscordOnboardingSeenKey(userId), "1");
    } catch (_err) {
      // ignore
    }
    clearPendingDiscordOnboarding();
  }

  function ensureDiscordOnboardingStyles() {
    if (document.getElementById("discord-onboarding-style")) return;
    const style = document.createElement("style");
    style.id = "discord-onboarding-style";
    style.textContent = `
      .discord-onboarding-modal {
        position: fixed;
        inset: 0;
        z-index: 12500;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 18px;
        background: rgba(12, 21, 51, 0.68);
      }
      .discord-onboarding-modal.open {
        display: flex;
      }
      .discord-onboarding-card {
        width: min(920px, 100%);
        max-height: min(90vh, 860px);
        background: #fff;
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: var(--shadow);
        display: grid;
        grid-template-rows: auto 1fr auto;
        overflow: hidden;
      }
      .discord-onboarding-head {
        padding: 18px 20px 14px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .discord-onboarding-head h3 {
        margin: 0;
        font-size: 24px;
      }
      .discord-onboarding-head p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }
      .discord-onboarding-close {
        width: 38px;
        height: 38px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: #fff;
        color: var(--ink);
        font-size: 18px;
        cursor: pointer;
      }
      .discord-onboarding-body {
        overflow-y: auto;
        padding: 18px 20px;
        display: grid;
        gap: 18px;
      }
      .discord-onboarding-section {
        display: grid;
        gap: 10px;
      }
      .discord-onboarding-section h4 {
        margin: 0;
        font-size: 17px;
      }
      .discord-onboarding-section p {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }
      .discord-onboarding-list {
        display: grid;
        gap: 10px;
      }
      .discord-onboarding-item {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 12px;
        display: flex;
        gap: 12px;
        align-items: center;
        background: rgba(12, 21, 51, 0.03);
      }
      .discord-onboarding-thumb {
        width: 54px;
        height: 54px;
        border-radius: 14px;
        object-fit: cover;
        background: #fff;
        border: 1px solid var(--border);
        flex-shrink: 0;
      }
      .discord-onboarding-copy {
        min-width: 0;
        flex: 1;
        display: grid;
        gap: 4px;
      }
      .discord-onboarding-copy strong {
        color: var(--ink);
      }
      .discord-onboarding-copy small {
        color: var(--muted);
        line-height: 1.45;
      }
      .discord-onboarding-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .discord-onboarding-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
        padding: 16px 20px 18px;
        border-top: 1px solid var(--border);
      }
      .discord-onboarding-empty {
        border: 1px dashed var(--border);
        border-radius: 14px;
        padding: 14px;
        color: var(--muted);
        background: rgba(12, 21, 51, 0.02);
        font-size: 14px;
      }
      @media (max-width: 720px) {
        .discord-onboarding-item {
          align-items: flex-start;
          flex-wrap: wrap;
        }
        .discord-onboarding-item .btn,
        .discord-onboarding-item .link-ghost {
          width: 100%;
          justify-content: center;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureDiscordOnboardingModal() {
    if (discordOnboardingModalRefs) return discordOnboardingModalRefs;
    ensureDiscordOnboardingStyles();
    let modal = document.getElementById("discord-onboarding-modal");
    if (!modal) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = `
        <div id="discord-onboarding-modal" class="discord-onboarding-modal" aria-hidden="true">
          <div class="discord-onboarding-card">
            <div class="discord-onboarding-head">
              <div>
                <h3>${escapeHtml(t("nav.discord_onboarding_title", "Seu discord no Gimerr"))}</h3>
              </div>
              <button type="button" class="discord-onboarding-close" id="discord-onboarding-close" aria-label="${escapeHtml(t("common.close", "Fechar"))}">×</button>
            </div>
            <div id="discord-onboarding-body" class="discord-onboarding-body"></div>
            <div class="discord-onboarding-actions">
              <button type="button" id="discord-onboarding-done" class="btn btn-primary">${escapeHtml(t("nav.discord_onboarding_done", "Entendi"))}</button>
            </div>
          </div>
        </div>
      `;
      modal = wrapper.firstElementChild;
      document.body.appendChild(modal);
    }
    discordOnboardingModalRefs = {
      modal,
      body: modal.querySelector("#discord-onboarding-body"),
      close: modal.querySelector("#discord-onboarding-close"),
      done: modal.querySelector("#discord-onboarding-done"),
    };
    return discordOnboardingModalRefs;
  }

  function closeDiscordOnboardingModal() {
    const refs = ensureDiscordOnboardingModal();
    refs.modal.classList.remove("open");
    refs.modal.setAttribute("aria-hidden", "true");
  }

  function openDiscordOnboardingModal() {
    const refs = ensureDiscordOnboardingModal();
    refs.modal.classList.add("open");
    refs.modal.setAttribute("aria-hidden", "false");
  }

  function buildDiscordGuildImageUrl(item) {
    const serverBannerUrl = String(item?.serverBannerUrl || "").trim();
    if (serverBannerUrl) return serverBannerUrl;
    const guildIconUrl = String(item?.guildIconUrl || "").trim();
    return guildIconUrl || "img/logo.png";
  }

  function renderDiscordOnboardingContent(data) {
    const refs = ensureDiscordOnboardingModal();
    const matchedServers = Array.isArray(data?.matchedServers) ? data.matchedServers : [];
    const manageableUnregisteredGuilds = Array.isArray(data?.manageableUnregisteredGuilds) ? data.manageableUnregisteredGuilds : [];

    const matchedMarkup = matchedServers.length
      ? matchedServers.map((item) => `
          <div class="discord-onboarding-item">
            <img class="discord-onboarding-thumb" src="${encodeURI(buildDiscordGuildImageUrl(item))}" alt="${escapeHtml(item.serverName || item.guildName || "Servidor")}" loading="lazy" />
            <div class="discord-onboarding-copy">
              <strong>${escapeHtml(item.serverName || item.guildName || "Servidor")}</strong>
              <div class="discord-onboarding-meta">
                <span class="pill">${escapeHtml(t("nav.discord_onboarding_registered", "Já está no Gimerr"))}</span>
                ${item.canManage ? `<span class="pill">${escapeHtml(t("nav.discord_onboarding_manageable", "Você administra este servidor"))}</span>` : ""}
              </div>
            </div>
            <button
              type="button"
              class="btn btn-ghost"
              data-action="discord-onboarding-follow"
              data-server-id="${escapeHtml(item.serverId)}"
              ${item.isFollowing ? "disabled" : ""}
            >${escapeHtml(item.isFollowing ? t("home.following", "Following") : t("home.follow_game", "Follow game"))}</button>
          </div>
        `).join("")
      : `<div class="discord-onboarding-empty">${escapeHtml(t("nav.discord_onboarding_no_registered", "Ainda não encontramos servidores do seu Discord vinculados ao Gimerr."))}</div>`;

    const manageableMarkup = manageableUnregisteredGuilds.length
      ? manageableUnregisteredGuilds.map((item) => `
          <div class="discord-onboarding-item">
            <img class="discord-onboarding-thumb" src="${encodeURI(buildDiscordGuildImageUrl(item))}" alt="${escapeHtml(item.guildName || "Servidor")}" loading="lazy" />
            <div class="discord-onboarding-copy">
              <strong>${escapeHtml(item.guildName || "Servidor")}</strong>
              <div class="discord-onboarding-meta">
                <span class="pill">${escapeHtml(t("nav.discord_onboarding_available", "Disponível para cadastrar"))}</span>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-primary"
              data-action="discord-onboarding-register"
              data-guild-id="${escapeHtml(item.guildId)}"
            >${escapeHtml(t("nav.discord_onboarding_register", "Cadastrar servidor"))}</button>
          </div>
        `).join("")
      : `<div class="discord-onboarding-empty">${escapeHtml(t("nav.discord_onboarding_no_manageable", "Você não tem outros servidores do Discord prontos para cadastro no momento."))}</div>`;

    refs.body.innerHTML = `
      <section class="discord-onboarding-section">
        <h4>${escapeHtml(t("nav.discord_onboarding_manage_title", "Seus servidores"))}</h4>
        <p>${escapeHtml(t("nav.discord_onboarding_manage_copy", "Estes são os servidores do seu Discord que você é dono ou tem permissão de administrador."))}</p>
        <div class="discord-onboarding-list">${manageableMarkup}</div>
      </section>
      <section class="discord-onboarding-section">
        <h4>${escapeHtml(t("nav.discord_onboarding_registered_title", "Servidores do seu Discord que já estão no Gimerr"))}</h4>
        <p>${escapeHtml(t("nav.discord_onboarding_registered_copy", "Selecione os servidores que você já quer seguir no Gimerr."))}</p>
        <div class="discord-onboarding-list">${matchedMarkup}</div>
      </section>
    `;
  }

  async function followServerFromOnboarding(serverId) {
    const normalizedServerId = String(serverId || "").trim();
    if (!normalizedServerId) return;
    const client = await getAuthClient();
    const { data } = await client.auth.getSession();
    const user = data?.session?.user || null;
    if (!user?.id) throw new Error(t("nav.auth_required", "Você precisa entrar para continuar."));
    const { error } = await client
      .from("server_follows")
      .insert({ user_id: user.id, server_id: normalizedServerId });
    if (error && error.code !== "23505") throw error;
  }

  async function registerServerFromDiscordGuild(client, session, guildId) {
    const normalizedGuildId = String(guildId || "").trim();
    if (!normalizedGuildId) throw new Error("Guild inválida.");
    const providerToken = String(session?.provider_token || "").trim();
    const accessToken = String(session?.access_token || "").trim();
    const { data, error } = await client.functions.invoke("discord_server_register", {
      body: {
        userToken: accessToken,
        providerToken,
        guildId: normalizedGuildId,
      },
    });
    if (error) throw error;
    return data || {};
  }

  function setPendingPartnerBotSetupServerId(serverId) {
    const normalizedServerId = String(serverId || "").trim();
    if (!normalizedServerId) return;
    try {
      sessionStorage.setItem(PARTNER_BOT_SETUP_STORAGE_KEY, normalizedServerId);
    } catch (_err) {
      // Ignore storage failures.
    }
  }

  async function fetchDiscordGuildsOverview(client, session) {
    const providerToken = String(session?.provider_token || "").trim();
    if (!providerToken) {
      throw new Error("Discord provider token missing.");
    }
    const accessToken = String(session?.access_token || "").trim();
    const { data, error } = await client.functions.invoke("discord_guilds_overview", {
      body: {
        userToken: accessToken,
        providerToken,
      },
    });
    if (error) throw error;
    return data || {};
  }

  async function maybeOpenDiscordOnboarding(client, session) {
    if (discordOnboardingBootstrapped) return;
    const user = session?.user || null;
    if (!user?.id) {
      clearPendingDiscordOnboarding();
      return;
    }
    const shouldOpenFromPendingState = hasPendingDiscordOnboarding();
    const shouldOpenFromDiscordSession = isDiscordAuthSession(session);
    if ((!shouldOpenFromPendingState && !shouldOpenFromDiscordSession) || hasSeenDiscordOnboarding(user.id) || !isDiscordAuthUser(user)) {
      return;
    }
    discordOnboardingBootstrapped = true;
    try {
      const overview = await fetchDiscordGuildsOverview(client, session);
      const matchedServers = Array.isArray(overview?.matchedServers) ? overview.matchedServers : [];
      const manageableUnregisteredGuilds = Array.isArray(overview?.manageableUnregisteredGuilds) ? overview.manageableUnregisteredGuilds : [];
      if (!matchedServers.length && !manageableUnregisteredGuilds.length) {
        markDiscordOnboardingSeen(user.id);
        return;
      }
      const refs = ensureDiscordOnboardingModal();
      renderDiscordOnboardingContent(overview);
      refs.done.onclick = () => {
        markDiscordOnboardingSeen(user.id);
        closeDiscordOnboardingModal();
      };
      refs.close.onclick = () => {
        markDiscordOnboardingSeen(user.id);
        closeDiscordOnboardingModal();
      };
      refs.body.onclick = async (event) => {
        const button = event.target?.closest?.('[data-action="discord-onboarding-follow"][data-server-id]');
        if (button) {
          const serverId = button.getAttribute("data-server-id");
          if (!serverId) return;
          const originalText = button.textContent;
          button.disabled = true;
          button.textContent = t("home.following", "Following");
          try {
            await followServerFromOnboarding(serverId);
          } catch (err) {
            console.error(err);
            button.disabled = false;
            button.textContent = originalText || t("home.follow_game", "Follow game");
          }
          return;
        }
        const registerBtn = event.target?.closest?.('[data-action="discord-onboarding-register"][data-guild-id]');
        if (registerBtn) {
          const guildId = registerBtn.getAttribute("data-guild-id");
          if (!guildId) return;
          const originalText = registerBtn.textContent;
          registerBtn.disabled = true;
          registerBtn.textContent = t("nav.discord_onboarding_registering", "Cadastrando...");
          try {
            const result = await registerServerFromDiscordGuild(client, session, guildId);
            const serverId = String(result?.server?.id || "").trim();
            if (serverId) {
              setPendingPartnerBotSetupServerId(serverId);
            }
            markDiscordOnboardingSeen(user.id);
            window.location.href = "partner.html";
          } catch (err) {
            console.error(err);
            registerBtn.disabled = false;
            registerBtn.textContent = originalText || t("nav.discord_onboarding_register", "Cadastrar servidor");
          }
        }
      };
      openDiscordOnboardingModal();
    } catch (err) {
      console.error("Falha ao carregar onboarding do Discord:", err);
      clearPendingDiscordOnboarding();
    }
  }

  class SiteNavbar extends HTMLElement {
    async initializeAuthUi() {
      const authBtn = this.querySelector("#auth-btn");
      const userMenu = this.querySelector("#user-menu");
      const avatarBtn = this.querySelector("#avatar-btn");
      const avatarImg = this.querySelector("#avatar-img");
      const userDropdown = this.querySelector(".user-dropdown");
      const logoutBtn = this.querySelector("#logout-btn");
      const createListingBtn = this.querySelector("#create-listing-btn");
      const menuCreateListing = this.querySelector("#menu-create-listing");
      const profileLink = this.querySelector("#profile-link");
      let isUserMenuOpen = false;

      const setUserMenuOpen = (isOpen) => {
        isUserMenuOpen = !!isOpen;
        userMenu?.classList.toggle("open", isUserMenuOpen);
        if (avatarBtn) {
          avatarBtn.setAttribute("aria-expanded", isUserMenuOpen ? "true" : "false");
        }
        if (userDropdown) {
          userDropdown.style.display = isUserMenuOpen ? "grid" : "none";
        }
      };

      const applyUserState = async (session) => {
        const user = session?.user || null;
        if (authBtn) authBtn.disabled = false;

        if (!user) {
          if (authBtn) authBtn.style.display = "";
          if (userMenu) {
            userMenu.style.display = "none";
          }
          setUserMenuOpen(false);
          if (createListingBtn) createListingBtn.style.display = "none";
          if (menuCreateListing) menuCreateListing.style.display = "none";
          if (profileLink) profileLink.href = "profile.html";
          if (avatarImg) avatarImg.src = "img/avatar.svg";
          return;
        }

        if (authBtn) authBtn.style.display = "none";
        if (userMenu) userMenu.style.display = "inline-flex";
        if (createListingBtn) createListingBtn.style.display = "inline-flex";
        if (menuCreateListing) menuCreateListing.style.display = "";
        if (profileLink) profileLink.href = `user?id=${encodeURIComponent(user.id)}`;

        let avatarUrl = "";
        try {
          const client = await getAuthClient();
          const { data, error } = await client
            .from("users")
            .select("avatar_url")
            .eq("id", user.id)
            .maybeSingle();
          if (!error) avatarUrl = String(data?.avatar_url || "").trim();
        } catch (_err) {
          // Ignore avatar lookup failures.
        }
        if (!avatarUrl) {
          avatarUrl = String(
            user?.user_metadata?.avatar_url
              || user?.user_metadata?.picture
              || user?.user_metadata?.avatar
              || "",
          ).trim();
        }
        if (avatarImg) {
          avatarImg.src = avatarUrl || "img/avatar.svg";
        }
      };

      try {
        const client = await getAuthClient();
        client.auth.onAuthStateChange((_event, session) => {
          applyUserState(session).catch((err) => console.error("Falha ao atualizar navbar:", err));
        });
        const { data } = await client.auth.getSession();
        await applyUserState(data?.session || null);
      } catch (err) {
        console.error("Falha ao inicializar auth do navbar:", err);
      }

      avatarBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        setUserMenuOpen(!isUserMenuOpen);
      });

      document.addEventListener("click", (event) => {
        if (!userMenu) return;
        if (!userMenu.contains(event.target)) {
          setUserMenuOpen(false);
        }
      });

      logoutBtn?.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          const client = await getAuthClient();
          await client.auth.signOut();
        } catch (err) {
          console.error("Falha ao encerrar sessão:", err);
        }
        window.location.href = "index.html";
      });

      const goToCreateListing = () => {
        window.location.href = "listing-create.html";
      };
      createListingBtn?.addEventListener("click", goToCreateListing);
      menuCreateListing?.addEventListener("click", (event) => {
        event.preventDefault();
        setUserMenuOpen(false);
        goToCreateListing();
      });
    }

    async initializeGlobalSearch() {
      if (this.dataset.searchBootstrapped === "1") return;
      this.dataset.searchBootstrapped = "1";
      if (isHomePage()) return;

      const searchForm = this.querySelector("#game-search");
      const searchInput = this.querySelector("#game-search-input");
      const searchSuggestions = this.querySelector("#search-suggestions");
      if (!searchForm || !searchInput || !searchSuggestions) return;

      const state = {
        games: [],
        players: [],
      };

      const showSuggestionMessage = (message) => {
        searchSuggestions.innerHTML = `<div class="suggestion-empty">${message}</div>`;
        searchSuggestions.style.display = "block";
      };

      const loadSearchCatalog = async () => {
        const [serversData, listingsData] = await Promise.all([
          fetchSupabaseRows("servers", {
            select: "id,name,official_site,banner_url",
            status: "eq.active",
          }),
          fetchSupabaseRows("users", {
            select: "id,username,first_name,last_name,email,avatar_url,discord_id,status",
            status: "eq.active",
            discord_id: "not.is.null",
          }),
        ]);

        state.games = await Promise.all((serversData || []).map(async (server) => ({
          id: server.id,
          name: server.name,
          website: server.official_site || "",
          cover_url: await resolveSearchImageUrl(server.banner_url || ""),
        })));

        state.players = (listingsData || [])
          .filter(hasSearchableListingProfile)
          .map(buildSearchablePlayer);
      };

      const renderSuggestions = (term) => {
        if (!term || term.length < 2) {
          searchSuggestions.style.display = "none";
          searchSuggestions.innerHTML = "";
          return;
        }
        const normalizedTerm = normalizeSearchText(term);
        const gameMatches = state.games
          .filter((game) => matchesPrefix(game.name, normalizedTerm))
          .slice(0, 6);
        const playerMatches = state.players
          .filter((player) => (player.searchTerms || []).some((value) => matchesPrefix(value, normalizedTerm)))
          .sort((a, b) => {
            const aUsername = normalizeSearchText(a.username || "");
            const bUsername = normalizeSearchText(b.username || "");
            const aStarts = aUsername.startsWith(normalizedTerm) ? 1 : 0;
            const bStarts = bUsername.startsWith(normalizedTerm) ? 1 : 0;
            if (bStarts !== aStarts) return bStarts - aStarts;
            return String(a.name || a.username || "").localeCompare(String(b.name || b.username || ""), "pt-BR", { sensitivity: "base" });
          })
          .slice(0, 6);

        if (gameMatches.length === 0 && playerMatches.length === 0) {
          searchSuggestions.innerHTML = `
            <div class="suggestion-empty">
              ${t("home.search_not_found_prefix", "Não encontramos games ou players para")} "${escapeHtml(term)}".
            </div>
          `;
          searchSuggestions.style.display = "block";
          return;
        }

        const gameItems = gameMatches.map((game) => {
          return `<div class="suggestion-item suggestion-item-rich" data-kind="game" data-game-id="${game.id}" data-game-name="${escapeHtml(game.name)}">
            <span class="suggestion-thumb suggestion-thumb-game">
              ${game.cover_url
                ? `<img src="${encodeURI(game.cover_url)}" alt="${escapeHtml(game.name)}" loading="lazy" />`
                : `<img src="img/logo.png" alt="" loading="lazy" />`}
            </span>
            <span class="suggestion-copy">
              <strong>${escapeHtml(game.name)}</strong>
            </span>
            <span class="badge">Game</span>
          </div>`;
        }).join("");

        const playerItems = playerMatches.map((player) => {
          const usernameLine = player.username
            ? `<small>@${escapeHtml(player.username)}</small>`
            : "";
          return `
          <div class="suggestion-item suggestion-item-rich" data-kind="player" data-user-id="${player.id}" data-user-name="${escapeHtml(player.name || player.username)}">
            <span class="suggestion-thumb suggestion-thumb-avatar">
              <img src="${encodeURI(player.avatar_url || "img/avatar.svg")}" alt="${escapeHtml(player.name)}" loading="lazy" referrerpolicy="no-referrer" />
            </span>
            <span class="suggestion-copy">
              <strong>${escapeHtml(player.name || player.username)}</strong>
              ${usernameLine}
            </span>
            <span class="badge">Player</span>
          </div>
        `;
        }).join("");

        searchSuggestions.innerHTML = `${gameItems}${playerItems}`;
        searchSuggestions.style.display = "block";
      };

      const handleSuggestionClick = (event) => {
        const item = event.target.closest(".suggestion-item");
        if (!item) return;
        const kind = item.getAttribute("data-kind");
        const gameId = item.getAttribute("data-game-id");
        const gameName = item.getAttribute("data-game-name");
        const userId = item.getAttribute("data-user-id");
        const userName = item.getAttribute("data-user-name");
        if (gameName) searchInput.value = gameName;
        if (userName) searchInput.value = userName;
        searchSuggestions.style.display = "none";
        if (kind === "game" && gameId) {
          window.location.href = `game?id=${encodeURIComponent(gameId)}`;
          return;
        }
        if (kind === "player" && userId) {
          window.location.href = `user?id=${encodeURIComponent(userId)}`;
        }
      };

      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const term = searchInput.value.trim();
        if (!term) {
          showSuggestionMessage(t("home.type_to_search", "Digite o nome de um game ou player para começar."));
          return;
        }
        const normalizedTerm = normalizeSearchText(term);
        const gameMatch = state.games.find((game) => normalizeSearchText(game.name) === normalizedTerm);
        if (gameMatch) {
          window.location.href = `game?id=${encodeURIComponent(gameMatch.id)}`;
          return;
        }
        const playerMatch = state.players.find((player) => {
          const username = normalizeSearchText(player.username || "");
          return username === normalizedTerm || normalizeSearchText(player.name) === normalizedTerm || player.searchText === normalizedTerm;
        });
        if (playerMatch) {
          window.location.href = `user?id=${encodeURIComponent(playerMatch.id)}`;
          return;
        }
        searchSuggestions.innerHTML = `
          <div class="suggestion-empty">
            ${t("home.search_not_found_simple", "Não encontramos")} "${escapeHtml(term)}".
          </div>
        `;
        searchSuggestions.style.display = "block";
      });

      searchInput.addEventListener("input", (event) => {
        renderSuggestions(event.target.value.trim());
      });
      searchInput.addEventListener("focus", () => {
        renderSuggestions(searchInput.value.trim());
      });
      searchSuggestions.addEventListener("click", handleSuggestionClick);
      document.addEventListener("click", (event) => {
        if (!this.contains(event.target)) {
          searchSuggestions.style.display = "none";
        }
      });

      try {
        await loadSearchCatalog();
      } catch (err) {
        console.error(err);
      }
    }

    connectedCallback() {
      if (this.dataset.rendered === "1") return;
      this.dataset.rendered = "1";
      this.style.display = "block";
      const searchEnabled = this.getAttribute("search-enabled") === "games";
      const searchMarkup = searchEnabled ? `
          <div class="nav-search">
            <form class="search nav-search-form" id="game-search">
              <div class="search-bar nav-search-bar">
                <input id="game-search-input" class="search-input nav-search-input" type="search" placeholder="${t("nav.search_placeholder", "Buscar...")}" aria-label="${t("nav.search_aria", "Buscar games ou players")}" autocomplete="off" />
                <button type="submit" class="btn btn-ghost nav-search-submit" aria-label="${t("nav.search_button", "Buscar")}">
                  <img src="img/lupa.svg" alt="" class="nav-search-submit-icon" aria-hidden="true" />
                </button>
              </div>
              <div class="suggestions nav-search-suggestions">
                <div id="search-suggestions" class="suggestions-panel" style="display:none;"></div>
              </div>
            </form>
          </div>
      ` : "";
      this.innerHTML = `
        <header class="site-nav">
          <a href="index.html" class="brand">
            <img src="img/logo.png" alt="Gimerr" class="brand-logo" />
            <div class="brand-copy">
              <span class="brand-tagline">${t("common.brand_tagline", "Community marketplace powered by gamers.")}</span>
            </div>
          </a>
          ${searchMarkup}
          <div class="nav-actions">
            <button id="create-listing-btn" class="btn btn-ghost create-listing-btn" type="button" style="display:none;">${t("nav.create_listing", "Criar anúncio")}</button>
            <button id="auth-btn" class="btn btn-primary">${t("nav.login", "Entrar")}</button>
            <div id="user-menu" class="nav-user">
              <button id="avatar-btn" class="avatar-btn" type="button" aria-label="Abrir menu do usuário">
                <img id="avatar-img" class="avatar-img" src="img/avatar.svg" alt="Foto do usuário" />
              </button>
              <div class="user-dropdown">
                <button id="menu-create-listing" class="menu-item create-listing-menu" type="button">${t("nav.create_listing", "Criar anúncio")}</button>
                <a id="my-listings-link" class="menu-item" href="my-listings.html">${t("nav.my_listings", "Meus anúncios")}</a>
                <a id="profile-link" class="menu-item" href="profile.html">${t("nav.my_profile", "Meu perfil")}</a>
                <a id="settings-link" class="menu-item" href="settings.html">${t("nav.settings", "Configurações")}</a>
                <a id="menu-partner-link" class="menu-item" href="partner.html" data-partner-link style="display:none;">${t("nav.partner_area", "Área de parceiros")}</a>
                <a id="help-link" class="menu-item" href="help.html">${t("nav.help", "Ajuda")}</a>
                <button id="logout-btn" class="menu-item" type="button">${t("nav.logout", "Sair")}</button>
              </div>
            </div>
          </div>
        </header>
      `;

      const authBtn = this.querySelector("#auth-btn");
      if (authBtn) {
        authBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          authBtn.disabled = true;
          window.__OPEN_AUTH_GATEWAY__?.();
        });
      }

      this.initializeGlobalSearch().catch((err) => {
        console.error("Falha ao inicializar busca global do navbar:", err);
      });
      this.initializeAuthUi().catch((err) => {
        console.error("Falha ao inicializar auth do navbar:", err);
      });
      window.__UPDATE_PARTNER_LINKS__?.(this);
    }
  }

  window.__NAVBAR_READY__ = (async () => {
    if (!customElements.get("site-navbar")) {
      customElements.define("site-navbar", SiteNavbar);
    }
    await Promise.resolve();
  })();
})();
