(() => {
  class SiteFooter extends HTMLElement {
    connectedCallback() {
      if (this.dataset.rendered === "1") return;
      this.dataset.rendered = "1";
      this.style.display = "block";
      this.innerHTML = `
        <footer class="site-footer">
          <div class="site-footer-inner">
            <div class="site-footer-brand">
              <img src="img/logo.png" alt="Gimerr" class="site-footer-logo" />
              <p>Community marketplace powered by gamers.</p>
            </div>
            <nav class="site-footer-links" aria-label="Links úteis">
              <a href="index.html">Início</a>
              <a href="game-submit.html">Cadastrar game</a>
              <a href="listing-create.html">Criar anúncio</a>
              <a href="my-listings.html">Meus anúncios</a>
              <a href="profile.html">Meu perfil</a>
              <a href="partner.html">Área de parceiros</a>
              <a href="politica-anuncios.html">Política de anúncios</a>
              <a href="parcerias.html">Termos de uso</a>
            </nav>
          </div>
        </footer>
      `;
    }
  }

  window.__FOOTER_READY__ = (async () => {
    if (!customElements.get("site-footer")) {
      customElements.define("site-footer", SiteFooter);
    }
    await Promise.resolve();
  })();
})();
