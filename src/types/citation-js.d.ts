declare module "@citation-js/core" {
  export class Cite {
    constructor(data?: unknown);
    data: unknown[];
    format(type: string, options?: Record<string, unknown>): string;
  }
}

declare module "@citation-js/plugin-bibtex";
declare module "@citation-js/plugin-csl";
declare module "@citation-js/plugin-ris";
