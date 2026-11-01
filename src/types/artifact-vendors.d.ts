declare module "plotly.js-strict-dist-min" {
  const plotly: {
    newPlot(
      container: HTMLElement,
      data: unknown[],
      layout: Record<string, unknown>,
      config: Record<string, unknown>,
    ): Promise<HTMLElement>;
    toImage(
      container: HTMLElement,
      options: { format: "png"; width: number; height: number },
    ): Promise<string>;
  };
  export default plotly;
}
declare module "d3-dsv" {
  export function csvParseRows(value: string): string[][];
  export function tsvParseRows(value: string): string[][];
}
