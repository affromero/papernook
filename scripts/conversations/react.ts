import * as Babel from "@babel/standalone";
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import * as ReactDOM from "react-dom";
import * as JSX from "react/jsx-runtime";
import * as Recharts from "recharts";
import * as Icons from "lucide-react";
import { compile } from "tailwindcss";

declare const PAPERNOOK_ARTIFACT_CSS: string;

export async function renderReact(source: string): Promise<void> {
  const result = Babel.transform(source, {
    filename: "artifact.tsx",
    sourceType: "module",
    babelrc: false,
    configFile: false,
    presets: ["typescript", ["react", { runtime: "classic" }]],
    plugins: ["transform-modules-commonjs"],
  });
  if (!result?.code)
    throw new Error("The React artifact could not be compiled.");
  const stylesheet = await compile(PAPERNOOK_ARTIFACT_CSS);
  const candidates = [
    ...new Set(
      source.split(/[\s"'`{};=<>]+/).filter((value) => value.length < 200),
    ),
  ];
  if (candidates.length > 20_000)
    throw new Error("Artifact styling exceeds the preview limit.");
  const style = document.createElement("style");
  style.textContent = stylesheet.build(candidates);
  document.head.append(style);
  const root = document.createElement("div");
  root.id = "artifact-root";
  document.body.append(root);
  Object.defineProperty(globalThis, "papernookReactModules", {
    configurable: true,
    value: {
      react: React,
      "react-dom/client": ReactDOMClient,
      "react-dom": ReactDOM,
      "react/jsx-runtime": JSX,
      recharts: Recharts,
      "lucide-react": Icons,
    },
  });
  const script = document.createElement("script");
  script.textContent = `(() => {
    const modules = globalThis.papernookReactModules;
    delete globalThis.papernookReactModules;
    const React = modules.react;
    const exports = {};
    const module = { exports };
    const require = name => {
      if (!Object.hasOwn(modules, name)) throw new Error('Unsupported artifact dependency: ' + name);
      return modules[name];
    };
    ${result.code}
    const Component = module.exports.default || (typeof App === 'function' ? App : null);
    if (!Component) throw new Error('The React artifact must export a default component or define App.');
    modules['react-dom/client'].createRoot(document.getElementById('artifact-root')).render(React.createElement(Component));
  })();`;
  document.body.append(script);
}
