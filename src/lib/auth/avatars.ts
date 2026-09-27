/**
 * Preset profile avatars: cute animals from the Colombian tropics. Each has an illustration at /avatars/{slug}.png shipped in
 * public/avatars. The profile picker, header menu, and settings grid all draw
 * from these through the validated avatar slug. The emoji and hue remain an offline
 * fallback tile.
 */

export interface AnimalAvatar {
  slug: string;
  name: string;
  /** Fallback glyph shown until the generated image exists. */
  emoji: string;
  /** Accent for the fallback tile gradient. */
  hue: string;
}

export const ANIMAL_AVATARS: AnimalAvatar[] = [
  { slug: "capybara", name: "Capybara", emoji: "🦫", hue: "#3F4FB0" },
  { slug: "iguana", name: "Iguana", emoji: "🦎", hue: "#0D9488" },
  { slug: "sloth", name: "Sloth", emoji: "🦥", hue: "#8A6D3B" },
  { slug: "toucan", name: "Toucan", emoji: "🐦", hue: "#B83280" },
  { slug: "macaw", name: "Macaw", emoji: "🦜", hue: "#C2730A" },
  { slug: "frog", name: "Poison frog", emoji: "🐸", hue: "#1C7A6B" },
  { slug: "hummingbird", name: "Hummingbird", emoji: "🐤", hue: "#6AA0FF" },
  { slug: "jaguar", name: "Jaguar", emoji: "🐆", hue: "#2A3550" },
];

const BY_SLUG = new Map(ANIMAL_AVATARS.map((a) => [a.slug, a]));

export function isAnimalSlug(value: string): boolean {
  return BY_SLUG.has(value);
}

/**
 * A stable animal avatar for a seed string (typically a username), so every
 * profile shows a distinct animal even when none was chosen. Deterministic.
 */
export function animalForSeed(seed: string): AnimalAvatar {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ANIMAL_AVATARS[hash % ANIMAL_AVATARS.length];
}
