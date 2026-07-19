import styles from "./LibraryCitationExport.module.css";

interface LibraryCitationExportProps {
  query: string;
  tag: string | null;
  topic: string | null;
}

function exportUrl(
  format: "csl-json" | "ris" | "bibtex" | "apa",
  filters: LibraryCitationExportProps,
): string {
  const params = new URLSearchParams({ format });
  if (filters.query) params.set("q", filters.query);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.topic) params.set("topic", filters.topic);
  return `/api/v1/citations?${params.toString()}`;
}

export function LibraryCitationExport(filters: LibraryCitationExportProps) {
  if (filters.topic === "_inbox") return null;
  return (
    <details className={styles.root}>
      <summary>Export citations</summary>
      <div className={styles.links}>
        <a href={exportUrl("csl-json", filters)}>CSL JSON</a>
        <a href={exportUrl("ris", filters)}>RIS</a>
        <a href={exportUrl("bibtex", filters)}>BibTeX</a>
        <a href={exportUrl("apa", filters)}>APA bibliography</a>
      </div>
    </details>
  );
}
