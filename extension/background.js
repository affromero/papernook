/*
 * papernook Safari/Chrome extension: redirect PDF navigations to the
 * papernook /viewer page, and offer a toolbar button for everything else.
 *
 * The DNR rules only match query-free URLs on purpose: regexSubstitution
 * pastes the matched text verbatim (no URL-encoding primitive exists), so a
 * source URL containing ?/& would corrupt the viewer's src parameter. URLs
 * with queries (openreview.net/pdf?id=…) go through the toolbar button,
 * which can encodeURIComponent properly.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

function viewerUrl(baseUrl, targetUrl) {
  return (
    baseUrl.replace(/\/+$/, "") + "/viewer?src=" + encodeURIComponent(targetUrl)
  );
}

async function rebuildRules() {
  const { baseUrl = "", autoIntercept = true } = await api.storage.sync.get({
    baseUrl: "",
    autoIntercept: true,
  });
  const existing = await api.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  let addRules = [];
  let host = null;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = null;
  }
  if (host && autoIntercept) {
    const substitution = baseUrl.replace(/\/+$/, "") + "/viewer?src=\\0";
    const rule = (id, regexFilter) => ({
      id,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: substitution },
      },
      condition: {
        regexFilter,
        resourceTypes: ["main_frame"],
        // Never intercept papernook itself: /viewer?src=….pdf and the
        // WebDAV tree would otherwise redirect-loop.
        excludedRequestDomains: [host],
      },
    });
    addRules = [
      rule(1, "^https?://arxiv\\.org/pdf/[^?#]*$"),
      rule(2, "^https?://[^?#]*\\.pdf$"),
    ];
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
