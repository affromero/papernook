/*
 * papernook Safari/Chrome extension: redirect PDF navigations on known
 * research hosts to the papernook /viewer page, and offer a toolbar button
 * for every other site.
 *
 * Host access is an explicit allowlist (never <all_urls>): DEFAULT_HOSTS
 * below, plus user-added hosts granted one at a time from the options page
 * via optional_host_permissions. The toolbar button needs no standing
 * permission anywhere — activeTab grants access on the click.
 *
 * The DNR rules only match query-free URLs on purpose: regexSubstitution
 * pastes the matched text verbatim (no URL-encoding primitive exists), so a
 * source URL containing ?/& would corrupt the viewer's src parameter. URLs
 * with queries (openreview.net/pdf?id=…) go through the toolbar button,
 * which can encodeURIComponent properly.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

// Mirrored as prose in options.html — keep the two in sync.
const DEFAULT_HOSTS = [
  "arxiv.org",
  "openreview.net",
  "biorxiv.org",
  "medrxiv.org",
  "aclanthology.org",
  "proceedings.neurips.cc",
  "proceedings.mlr.press",
  "openaccess.thecvf.com",
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function viewerUrl(baseUrl, targetUrl) {
  return (
    baseUrl.replace(/\/+$/, "") + "/viewer?src=" + encodeURIComponent(targetUrl)
  );
}

async function rebuildRules() {
  const {
    baseUrl = "",
    autoIntercept = true,
    extraHosts = [],
  } = await api.storage.sync.get({
    baseUrl: "",
    autoIntercept: true,
    extraHosts: [],
  });
  const existing = await api.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  let addRules = [];
  let papernookHost = null;
  try {
    papernookHost = new URL(baseUrl).hostname;
  } catch {
    papernookHost = null;
  }
  if (papernookHost && autoIntercept) {
    const substitution = baseUrl.replace(/\/+$/, "") + "/viewer?src=\\0";
    // Never intercept papernook itself: /viewer?src=….pdf and the WebDAV
    // tree would otherwise redirect-loop.
    const hosts = [...new Set([...DEFAULT_HOSTS, ...extraHosts])].filter(
      (host) => host !== papernookHost,
    );
    addRules = hosts.map((host, index) => ({
      id: index + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: substitution },
      },
      condition: {
        // arXiv serves PDFs under /pdf/ with no .pdf suffix; everywhere else
        // match query-free .pdf URLs on the host or its subdomains.
        regexFilter:
          host === "arxiv.org"
            ? "^https?://(www\\.)?arxiv\\.org/pdf/[^?#]*$"
            : `^https?://([^/]+\\.)?${escapeRegex(host)}/[^?#]*\\.pdf$`,
        resourceTypes: ["main_frame"],
      },
    }));
  }
  await api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

api.runtime.onInstalled.addListener(() => {
  rebuildRules().catch(console.error);
});
api.storage.onChanged.addListener(() => {
  rebuildRules().catch(console.error);
});

api.action.onClicked.addListener((tab) => {
  (async () => {
    const { baseUrl = "" } = await api.storage.sync.get({ baseUrl: "" });
    if (!baseUrl) {
      await api.runtime.openOptionsPage();
      return;
    }
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;
    await api.tabs.create({ url: viewerUrl(baseUrl, tab.url) });
  })().catch(console.error);
});
