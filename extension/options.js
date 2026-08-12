const api = typeof browser !== "undefined" ? browser : chrome;

const baseUrlInput = document.getElementById("base-url");
const autoInput = document.getElementById("auto-intercept");
const extraHostInput = document.getElementById("extra-host");
const extraHostsList = document.getElementById("extra-hosts");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");
let flashTimer;

function flash(message, ok) {
  clearTimeout(flashTimer);
  status.textContent = message;
  status.style.color = ok === undefined ? "#555" : ok ? "#2e7d32" : "#b3261e";
  if (ok) {
    flashTimer = setTimeout(() => {
      status.textContent = "";
    }, 4000);
  }
}

function serverOriginPattern(url) {
  return `${url.protocol}//${url.hostname}/*`;
}

async function testServer(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`server returned HTTP ${response.status}`);
    }
    const result = await response.json();
    if (!result || result.status !== "ok") {
      throw new Error("server returned an unexpected health response");
    }
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("the server did not respond within 10 seconds");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestServerAccess(url) {
  const permission = { origins: [serverOriginPattern(url)] };
  if (await api.permissions.contains(permission)) return true;
  return api.permissions.request(permission);
}

async function renderExtraHosts() {
  const { extraHosts = [] } = await api.storage.sync.get({ extraHosts: [] });
  extraHostsList.replaceChildren(
    ...extraHosts.map((host) => {
      const item = document.createElement("li");
      item.textContent = host + " ";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        const { extraHosts: current = [] } = await api.storage.sync.get({
          extraHosts: [],
        });
        await api.storage.sync.set({
          extraHosts: current.filter((h) => h !== host),
        });
        api.permissions
          .remove({ origins: [`*://*.${host}/*`] })
          .catch(() => {});
        renderExtraHosts();
      });
      item.append(remove);
      return item;
    }),
  );
}

api.storage.sync
  .get({ baseUrl: "", autoIntercept: true })
  .then(({ baseUrl, autoIntercept }) => {
    baseUrlInput.value = baseUrl;
    autoInput.checked = autoIntercept;
  });
renderExtraHosts();

document.getElementById("add-host").addEventListener("click", async () => {
  const raw = extraHostInput.value.trim().toLowerCase();
  const host = raw.replace(/^[a-z]+:\/\//, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    flash("Enter a domain like journals.example.org", false);
    return;
  }
  let granted = false;
  try {
    granted = await api.permissions.request({ origins: [`*://*.${host}/*`] });
  } catch {
    granted = false;
  }
  if (!granted) {
    flash(
      "The browser did not grant access — use the toolbar button there.",
      false,
    );
    return;
  }
  const { extraHosts = [] } = await api.storage.sync.get({ extraHosts: [] });
  if (!extraHosts.includes(host)) {
    await api.storage.sync.set({ extraHosts: [...extraHosts, host] });
  }
  extraHostInput.value = "";
  flash("Added.", true);
  renderExtraHosts();
});

saveButton.addEventListener("click", async () => {
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("http(s) only");
    }
  } catch {
    flash("Enter a full http(s) URL.", false);
    return;
  }

  saveButton.disabled = true;
  flash("Saving and testing connection…");
  let serverAccess = false;
  try {
    serverAccess = await requestServerAccess(parsed);
  } catch {
    serverAccess = false;
  }

  try {
    await api.storage.sync.set({
      baseUrl,
      autoIntercept: autoInput.checked,
    });

    let rulesResult;
    try {
      rulesResult = await api.runtime.sendMessage("rebuild-rules");
    } catch {
      rulesResult = { ok: false };
    }

    if (!serverAccess) {
      flash(
        "Saved, but the browser did not grant server access, so the connection could not be tested.",
        false,
      );
      return;
    }

    try {
      await testServer(baseUrl);
    } catch (error) {
      flash(
        `Saved, but the connection test failed: ${error instanceof Error ? error.message : "could not reach the server"}.`,
        false,
      );
      return;
    }

    if (rulesResult && rulesResult.ok === false) {
      flash(
        "Saved and connected, but the browser refused the redirect rules — turn off automatic opening and use the toolbar button.",
        false,
      );
      return;
    }
    flash("Saved. Connection successful.", true);
  } catch (error) {
    flash(
      `Could not save settings: ${error instanceof Error ? error.message : "unknown error"}.`,
      false,
    );
  } finally {
    saveButton.disabled = false;
  }
});
