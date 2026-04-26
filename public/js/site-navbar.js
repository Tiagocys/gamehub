(() => {
  const i18n = window.__I18N__ || { t: (_key, fallback = "") => fallback };
  const t = (key, fallback = "") => i18n.t(key, fallback);
  let authClientPromise = null;
  let profileSyncBootstrapped = false;
  let partnerAccessCache = {
    userId: null,
    canAccess: false,
  };

  function normalizeUsername(value) {
    const clean = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 32);
    return clean || "user";
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
    const meta = user?.user_metadata || {};
    const given = meta.given_name || meta.first_name || "";
    const family = meta.family_name || meta.last_name || "";
    if (given || family) {
      return { first_name: given || null, last_name: family || null };
    }
    const full = String(meta.full_name || meta.name || "").trim();
    if (!full) return { first_name: null, last_name: null };
    const parts = full.split(/\s+/);
    if (parts.length === 1) return { first_name: parts[0], last_name: null };
    return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
  }

  function baseUsernameFromUser(user) {
    const fromName = String(user?.user_metadata?.full_name || "").trim().split(/\s+/)[0];
    if (fromName) return normalizeUsername(fromName);
    return normalizeUsername(String(user?.email || "").split("@")[0]);
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
      .select("username")
      .eq("id", user.id)
      .maybeSingle();
    if (existing.error && existing.error.code !== "PGRST116") {
      throw existing.error;
    }

    const names = parseUserName(user);
    const baseUsername = baseUsernameFromUser(user);
    const candidates = Array.from(new Set([
      existing.data?.username || "",
      baseUsername,
      `${baseUsername}-${Math.floor(Math.random() * 9000 + 1000)}`,
      `${baseUsername}-${crypto.randomUUID().slice(0, 6)}`,
    ].filter(Boolean)));

    let lastError = null;
    for (const username of candidates) {
      const payload = {
        id: user.id,
        username,
        email: user.email,
        avatar_url: user.user_metadata?.avatar_url ?? user.user_metadata?.picture ?? null,
        first_name: names.first_name,
        last_name: names.last_name,
        locale: detectUserLocale(),
      };
      const { error } = await client.from("users").upsert(payload, { onConflict: "id" });
      if (!error) return;
      if (error.code === "23505") {
        lastError = error;
        continue;
      }
      throw error;
    }
    if (lastError) throw lastError;
  }

  async function bootstrapProfileSync(client) {
    if (profileSyncBootstrapped) return;
    profileSyncBootstrapped = true;

    client.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) return;
      ensurePublicUserProfile(client, session.user).catch((err) => {
        console.error("Falha ao sincronizar perfil público:", err);
      });
      partnerAccessCache = { userId: null, canAccess: false };
      updatePartnerLinksVisibility(document).catch(() => {});
    });

    const { data } = await client.auth.getSession();
    if (data?.session?.user) {
      ensurePublicUserProfile(client, data.session.user).catch((err) => {
        console.error("Falha ao sincronizar perfil público:", err);
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

    let serverCount = 0;
    let serverQuery = await client
      .from("servers")
      .select("id", { count: "exact", head: true })
      .or(`owner_id.eq.${userId},admin_beneficiary_id.eq.${userId}`)
      .neq("status", "deleted");

    if (serverQuery.error && String(serverQuery.error.message || "").includes("admin_beneficiary_id")) {
      serverQuery = await client
        .from("servers")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", userId)
        .neq("status", "deleted");
    }

    if (!serverQuery.error) {
      serverCount = Number(serverQuery.count || 0);
    }

    const canAccess = serverCount > 0;
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

  class SiteNavbar extends HTMLElement {
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
          fetchSupabaseRows("listings", {
            select: "user_id",
            status: "eq.active",
          }),
        ]);

        state.games = await Promise.all((serversData || []).map(async (server) => ({
          id: server.id,
          name: server.name,
          website: server.official_site || "",
          cover_url: await resolveSearchImageUrl(server.banner_url || ""),
        })));

        const userIds = Array.from(new Set((listingsData || []).map((item) => item.user_id).filter(Boolean)));
        if (userIds.length === 0) {
          state.players = [];
          return;
        }

        const usersData = await fetchSupabaseRows("users", {
          select: "id,username,first_name,last_name,email,avatar_url,status",
          id: `in.(${userIds.join(",")})`,
          status: "eq.active",
        });

        state.players = (usersData || []).map(buildSearchablePlayer);
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
            return String(a.username || a.name || "").localeCompare(String(b.username || b.name || ""), "pt-BR", { sensitivity: "base" });
          })
          .slice(0, 6);

        if (gameMatches.length === 0 && playerMatches.length === 0) {
          searchSuggestions.innerHTML = `
            <div class="suggestion-empty">
              ${t("home.search_not_found_prefix", "Não encontramos games ou players para")} "${escapeHtml(term)}".
              <a class="link-ghost" href="game-submit.html" data-action="game-submit">${t("home.submit_game_cta", "Clique aqui")}</a> ${t("home.submit_game_suffix", "para cadastrar um novo game.")}
            </div>
          `;
          searchSuggestions.style.display = "block";
          return;
        }

        const gameItems = gameMatches.map((game) => {
          const websiteLabel = String(game.website || "").replace(/^https?:\/\//i, "").replace(/\/$/, "") || "Sem site oficial";
          return `<div class="suggestion-item suggestion-item-rich" data-kind="game" data-game-id="${game.id}" data-game-name="${escapeHtml(game.name)}">
            <span class="suggestion-thumb suggestion-thumb-game">
              ${game.cover_url
                ? `<img src="${encodeURI(game.cover_url)}" alt="${escapeHtml(game.name)}" loading="lazy" />`
                : `<img src="img/logo.png" alt="" loading="lazy" />`}
            </span>
            <span class="suggestion-copy">
              <strong>${escapeHtml(game.name)}</strong>
              <small>${escapeHtml(websiteLabel)}</small>
            </span>
            <span class="badge">Game</span>
          </div>`;
        }).join("");

        const playerItems = playerMatches.map((player) => `
          <div class="suggestion-item suggestion-item-rich" data-kind="player" data-user-id="${player.id}" data-user-name="${escapeHtml(player.username || player.name)}">
            <span class="suggestion-thumb suggestion-thumb-avatar">
              <img src="${encodeURI(player.avatar_url || "img/avatar.svg")}" alt="${escapeHtml(player.name)}" loading="lazy" referrerpolicy="no-referrer" />
            </span>
            <span class="suggestion-copy">
              <strong>${escapeHtml(player.username || player.name)}</strong>
              <small>${escapeHtml(player.name)}</small>
            </span>
            <span class="badge">Player</span>
          </div>
        `).join("");

        searchSuggestions.innerHTML = `${gameItems}${playerItems}`;
        searchSuggestions.style.display = "block";
      };

      const handleSuggestionClick = (event) => {
        const submitLink = event.target.closest('a[data-action="game-submit"]');
        if (submitLink) {
          event.preventDefault();
          window.location.href = "game-submit.html";
          return;
        }

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
          window.location.href = `game.html?id=${encodeURIComponent(gameId)}`;
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
          window.location.href = `game.html?id=${encodeURIComponent(gameMatch.id)}`;
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
            <a href="game-submit.html" class="link-ghost" data-action="game-submit">${t("home.submit_game_cta", "Clique aqui")}</a> ${t("home.submit_game_suffix", "para cadastrar um novo game.")}
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
