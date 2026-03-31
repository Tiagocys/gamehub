(() => {
  function safeGetStorage(key) {
    try {
      return window.localStorage?.getItem(key) || "";
    } catch (_err) {
      return "";
    }
  }

  function normalizeLocale(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "";
    return normalized.startsWith("pt") ? "pt-BR" : "en";
  }

  function normalizeCurrency(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "";
    return normalized === "usd" ? "usd" : normalized === "brl" ? "brl" : "";
  }

  function detectLocale(sourceLocale) {
    const normalized = normalizeLocale(sourceLocale);
    return normalized || "en";
  }

  function detectCurrency(sourceLocale) {
    const normalized = String(sourceLocale || "").toLowerCase();
    return normalized.startsWith("pt") ? "brl" : "usd";
  }

  const sourceLocale = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
  const forcedLocale = normalizeLocale(safeGetStorage("gimerr-locale-force"));
  const forcedCurrency = normalizeCurrency(safeGetStorage("gimerr-currency-force"));
  const locale = forcedLocale || detectLocale(sourceLocale);
  const currency = forcedCurrency || detectCurrency(sourceLocale);
  const messages = window.__I18N_MESSAGES__ || {};

  window.__I18N__ = {
    locale,
    currency,
    sourceLocale,
    t(key, fallback = "") {
      return messages[locale]?.[key] || messages["en"]?.[key] || messages["pt-BR"]?.[key] || fallback || key;
    },
  };
})();
