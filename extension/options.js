const api = typeof browser !== "undefined" ? browser : chrome;

const baseUrlInput = document.getElementById("base-url");
const autoInput = document.getElementById("auto-intercept");
const extraHostInput = document.getElementById("extra-host");
const extraHostsList = document.getElementById("extra-hosts");
const status = document.getElementById("status");

function flash(message, ok) {
  status.textContent = message;
  status.style.color = ok ? "#2e7d32" : "#b3261e";
  if (ok) {
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  }
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
    flash("Safari did not grant access — use the toolbar button there.", false);
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

document.getElementById("save").addEventListener("click", () => {
  let baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("http(s) only");
    }
  } catch {
    flash("Enter a full http(s) URL.", false);
    return;
  }
  api.storage.sync
    .set({ baseUrl, autoIntercept: autoInput.checked })
    .then(() => flash("Saved.", true));
});
