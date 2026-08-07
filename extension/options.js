const api = typeof browser !== "undefined" ? browser : chrome;

const baseUrlInput = document.getElementById("base-url");
const autoInput = document.getElementById("auto-intercept");
const status = document.getElementById("status");

api.storage.sync
  .get({ baseUrl: "", autoIntercept: true })
  .then(({ baseUrl, autoIntercept }) => {
    baseUrlInput.value = baseUrl;
    autoInput.checked = autoIntercept;
  });

document.getElementById("save").addEventListener("click", () => {
  let baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("http(s) only");
    }
  } catch {
    status.textContent = "Enter a full http(s) URL.";
    status.style.color = "#b3261e";
    return;
  }
  api.storage.sync
    .set({ baseUrl, autoIntercept: autoInput.checked })
    .then(() => {
      status.textContent = "Saved.";
      status.style.color = "#2e7d32";
      setTimeout(() => {
        status.textContent = "";
      }, 2000);
    });
});
