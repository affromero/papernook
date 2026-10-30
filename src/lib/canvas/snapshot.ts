/** Tldraw includes local user records in document scope. They are never paper content. */
export function withoutCanvasUsers(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("store" in value)) return value;
  const store = value.store;
  if (!store || typeof store !== "object" || Array.isArray(store)) return value;
  return {
    ...value,
    store: Object.fromEntries(
      Object.entries(store).filter(
        ([, record]) =>
          !record ||
          typeof record !== "object" ||
          !("typeName" in record) ||
          record.typeName !== "user",
      ),
    ),
  };
}
