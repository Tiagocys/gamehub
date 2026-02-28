(() => {
  async function updateFooterPartnerVisibility(scope) {
    const nodes = Array.from((scope || document).querySelectorAll("[data-partner-link]"));
    if (nodes.length === 0) return;

    let canAccess = false;
    try {
      if (typeof window.__RESOLVE_PARTNER_AREA_ACCESS__ === "function") {
        canAccess = await window.__RESOLVE_PARTNER_AREA_ACCESS__();
      }
    } catch (_err) {
      canAccess = false;
    }

    nodes.forEach((node) => {
      node.style.display = canAccess ? "" : "none";
    });
  }

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
              <a href="ad-wallet.html">Conta de anúncios</a>
              <a href="partner.html" data-partner-link style="display:none;">Área de parceiros</a>
              <a href="ads-policy.html">Política de anúncios</a>
              <a href="terms.html">Termos de uso</a>
            </nav>
          </div>
        </footer>
      `;

      updateFooterPartnerVisibility(this);
      document.addEventListener("gimerr:partner-access", (event) => {
        const canAccess = !!event?.detail?.canAccess;
        const nodes = Array.from(this.querySelectorAll("[data-partner-link]"));
        nodes.forEach((node) => {
          node.style.display = canAccess ? "" : "none";
        });
      });
    }
  }

  window.__FOOTER_READY__ = (async () => {
    if (!customElements.get("site-footer")) {
      customElements.define("site-footer", SiteFooter);
    }
    await Promise.resolve();
  })();
})();
