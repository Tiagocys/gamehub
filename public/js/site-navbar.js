(() => {
  let authClientPromise = null;
  let partnerAccessCache = {
    userId: null,
    canAccess: false,
  };

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
      return createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "gimerr-auth-token",
        },
      });
    })();
    return authClientPromise;
  }

  async function startGoogleLogin() {
    const client = await getAuthClient();
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/index.html` },
    });
    if (error) throw error;
  }

  window.__NAVBAR_GOOGLE_LOGIN__ = async function navbarGoogleLogin(event, buttonEl) {
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
