(() => {
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
    });

    const { data } = await client.auth.getSession();
    if (data?.session?.user) {
      ensurePublicUserProfile(client, data.session.user).catch((err) => {
        console.error("Falha ao sincronizar perfil público:", err);
      });
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

  window.__NAVBAR_GOOGLE_LOGIN__ = async function navbarGoogleLogin(_event, buttonEl) {
    try {
      if (buttonEl) buttonEl.disabled = true;
      await startGoogleLogin();
    } catch (err) {
      console.error(err);
      if (buttonEl) buttonEl.disabled = false;
      alert(err?.message || "Falha no login com Google.");
    }
  };

  function isMissingAdminBeneficiaryColumnError(error) {
    if (!error) return false;
    return String(error.message || "").includes("admin_beneficiary_id");
  }

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

    const { data: profile, error: profileError } = await client
      .from("users")
      .select("is_admin,is_partner")
      .eq("id", userId)
      .maybeSingle();
    if (!profileError && (profile?.is_admin || profile?.is_partner)) {
      partnerAccessCache = { userId, canAccess: true };
      return true;
    }

    let serverCount = 0;
    const serverQuery = await client
      .from("servers")
      .select("id", { count: "exact", head: true })
      .or(`owner_id.eq.${userId},admin_beneficiary_id.eq.${userId}`);

    if (isMissingAdminBeneficiaryColumnError(serverQuery.error)) {
      const fallback = await client
        .from("servers")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", userId);
      if (!fallback.error) {
        serverCount = Number(fallback.count || 0);
      }
    } else if (!serverQuery.error) {
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
    connectedCallback() {
      if (this.dataset.rendered === "1") return;
      this.dataset.rendered = "1";
      this.style.display = "block";
      this.innerHTML = `
        <header class="site-nav">
          <a href="index.html" class="brand">
            <img src="img/logo.png" alt="Gimerr" class="brand-logo" />
            <div class="brand-copy">
              <span class="brand-tagline">Community marketplace powered by gamers.</span>
            </div>
          </a>
          <div class="nav-actions">
            <button id="create-listing-btn" class="btn btn-ghost create-listing-btn" type="button" style="display:none;">Criar anúncio</button>
            <button id="auth-btn" class="btn btn-primary"><img src="img/google.svg" alt="" class="btn-google-logo" /> Entrar com Google</button>
            <div id="user-menu" class="nav-user">
              <button id="avatar-btn" class="avatar-btn" type="button" aria-label="Abrir menu do usuário">
                <img id="avatar-img" class="avatar-img" src="img/avatar.svg" alt="Foto do usuário" />
              </button>
              <div class="user-dropdown">
                <button id="menu-create-listing" class="menu-item create-listing-menu" type="button">Criar anúncio</button>
                <a id="my-listings-link" class="menu-item" href="my-listings.html">Meus anúncios</a>
                <a id="profile-link" class="menu-item" href="profile.html">Meu perfil</a>
                <a id="menu-partner-link" class="menu-item" href="partner.html" data-partner-link style="display:none;">Área de parceiros</a>
                <button id="logout-btn" class="menu-item" type="button">Sair</button>
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
          window.__NAVBAR_GOOGLE_LOGIN__?.(event, authBtn);
        });
      }

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
