import { object, text } from "../../src/lib/conversations/formats/schema";

/** Display saved standard widget values without a kernel or model-module loader. */
export function renderWidget(view: unknown, exported: unknown): void {
  const id = text(object(view)?.model_id);
  const states = object(object(exported)?.state);
  if (!states || !id)
    throw new Error(
      "This widget has no exported state. A live kernel is not available.",
    );
  const visited = new Set<string>();
  function render(id: string, depth = 0): HTMLElement {
    if (depth > 30 || visited.has(id))
      throw new Error("Invalid or cyclic saved widget state.");
    visited.add(id);
    const model = object(states?.[id]);
    const state = object(model?.state);
    if (!state) throw new Error("Saved widget state is incomplete.");
    const name = text(model?.model_name ?? state._model_name);
    const moduleName = text(model?.model_module ?? state._model_module);
    if (
      moduleName &&
      !["@jupyter-widgets/controls", "@jupyter-widgets/base"].includes(
        moduleName,
      )
    )
      throw new Error(`Unsupported saved widget module: ${moduleName}.`);
    const root = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = text(state.description);
    root.append(label);
    if (
      [
        "HBoxModel",
        "VBoxModel",
        "BoxModel",
        "TabModel",
        "AccordionModel",
      ].includes(name)
    ) {
      for (const child of Array.isArray(state.children) ? state.children : [])
        root.append(render(text(child).replace(/^IPY_MODEL_/, ""), depth + 1));
    } else if (
      [
        "IntSliderModel",
        "FloatSliderModel",
        "IntTextModel",
        "FloatTextModel",
        "BoundedIntTextModel",
        "BoundedFloatTextModel",
        "TextModel",
        "TextareaModel",
        "CheckboxModel",
        "ToggleButtonModel",
        "DropdownModel",
        "SelectModel",
        "RadioButtonsModel",
        "IntProgressModel",
        "FloatProgressModel",
      ].includes(name)
    ) {
      const value = document.createElement("output");
      const labels = Array.isArray(state._options_labels)
        ? state._options_labels
        : [];
      value.textContent = String(
        state.value ?? labels[Number(state.index)] ?? "",
      );
      label.append(value);
      if (/Slider|Progress/.test(name)) {
        const meter = document.createElement("meter");
        meter.min = Number(state.min) || 0;
        meter.max = Number(state.max) || 100;
        meter.value = Number(state.value) || 0;
        meter.setAttribute(
          "aria-label",
          text(state.description) || "Saved widget value",
        );
        root.append(meter);
      }
    } else if (["LabelModel", "HTMLModel", "HTMLMathModel"].includes(name)) {
      const value = document.createElement("span");
      value.textContent = text(state.value);
      root.append(value);
    } else if (name === "ButtonModel") {
      const button = document.createElement("button");
      button.textContent = text(state.description) || "Widget action";
      button.disabled = true;
      root.append(button);
    } else
      throw new Error(
        `Unsupported saved widget: ${name}. Its state is available in the source.`,
      );
    visited.delete(id);
    return root;
  }
  document.body.append(render(id));
  const notice = document.createElement("p");
  notice.textContent = "Saved widget state. Kernel actions are unavailable.";
  document.body.append(notice);
}
