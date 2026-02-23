(() => {
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
                <button id="logout-btn" class="menu-item" type="button">Sair</button>
              </div>
            </div>
          </div>
        </header>
      `;
    }
  }

  window.__NAVBAR_READY__ = (async () => {
    if (!customElements.get("site-navbar")) {
      customElements.define("site-navbar", SiteNavbar);
    }
    await Promise.resolve();
  })();
})();
