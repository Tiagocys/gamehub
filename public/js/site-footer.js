(() => {
  const i18n = window.__I18N__ || { t: (_key, fallback = "") => fallback };
  const t = (key, fallback = "") => i18n.t(key, fallback);

  function setForcedLocale(locale) {
    try {
      window.localStorage?.setItem("gimerr-locale-force", locale);
    } catch (_err) {
      // ignore storage failures
    }
    window.location.reload();
  }

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
            <nav class="site-footer-links site-footer-languages" aria-label="${escapeAttr(t("footer.languages_aria", "Language selector"))}">
              <a href="#" class="${i18n.locale === "pt-BR" ? "active" : ""}" data-locale="pt-BR">Português (Brasil)</a>
              <a href="#" class="${i18n.locale === "es" ? "active" : ""}" data-locale="es">Español</a>
              <a href="#" class="${i18n.locale === "en" ? "active" : ""}" data-locale="en">English</a>
            </nav>
            <nav class="site-footer-links" aria-label="Links úteis">
              <a href="partner.html" data-partner-link style="display:none;">${t("footer.partner_area", "Área de parceiros")}</a>
              <a href="ads-policy.html">${t("footer.ads_policy", "Políticas de anúncios")}</a>
              <a href="privacy-policy.html">${t("footer.privacy_policy", "Políticas de privacidade")}</a>
              <a href="terms.html">${t("footer.terms", "Termos de uso")}</a>
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

      this.addEventListener("click", (event) => {
        const link = event.target.closest("[data-locale]");
        if (!link) return;
        event.preventDefault();
        const locale = String(link.getAttribute("data-locale") || "").trim();
        if (!locale || locale === i18n.locale) return;
        setForcedLocale(locale);
      });
    }
  }

  function escapeAttr(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  window.__FOOTER_READY__ = (async () => {
    if (!customElements.get("site-footer")) {
      customElements.define("site-footer", SiteFooter);
    }
    await Promise.resolve();
  })();
})();
