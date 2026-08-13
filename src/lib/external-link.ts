export interface ExternalLinkProps {
  target: "_blank";
  rel: string;
}

/**
 * Browser-safe attributes for links that leave the current HTTP(S) origin.
 * Relative and non-web URLs stay in the current tab. When no current origin
 * is available, absolute and protocol-relative web URLs are external.
 */
export function externalLinkProps(
  href: string,
  currentOrigin?: string,
  nofollow = false,
): ExternalLinkProps | Record<string, never> {
  const value = href.trim();
  if (!value) return {};

  let destination: URL;
  try {
    if (currentOrigin) {
      destination = new URL(value, currentOrigin);
    } else if (/^https?:\/\//i.test(value)) {
      destination = new URL(value);
    } else if (value.startsWith("//")) {
      destination = new URL(`https:${value}`);
    } else {
      return {};
    }
  } catch {
    return {};
  }

  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    return {};
  }
  if (currentOrigin) {
    try {
      if (destination.origin === new URL(currentOrigin).origin) return {};
    } catch {
      return {};
    }
  }

  return {
    target: "_blank",
    rel: `noopener noreferrer${nofollow ? " nofollow" : ""}`,
  };
}
