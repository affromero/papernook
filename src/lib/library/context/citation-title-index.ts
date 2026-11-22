import {
  titleCited,
  tokenizeTitle,
  type ReferenceTokens,
} from "./reference-match";

export function indexCitationTitles(paperTitles: readonly string[]) {
  const titles = paperTitles.map(tokenizeTitle);
  const frequencies = new Map<string, number>();
  for (const { words } of titles) {
    for (const word of new Set(words)) {
      frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    }
  }

  const postings = new Map<string, number[]>();
  titles.forEach(({ words }, index) => {
    if (words.length < 2) return;
    // An 80% match can miss at most one position in five. Indexing one
    // more position guarantees a hit for every match, even with repeats.
    // A short phrase match contains every position, so one also suffices.
    const positions = Math.floor(words.length / 5) + 1;
    const rareWords = [...words]
      .sort((a, b) => (frequencies.get(a) ?? 0) - (frequencies.get(b) ?? 0))
      .slice(0, positions);
    for (const word of new Set(rareWords)) {
      const indices = postings.get(word);
      if (indices) indices.push(index);
      else postings.set(word, [index]);
    }
  });

  return function* matchingTitleIndices(
    reference: ReferenceTokens,
  ): Generator<number> {
    const checked = new Set<number>();
    for (const word of reference.words) {
      const indices = postings.get(word);
      if (!indices) continue;
      for (const index of indices) {
        if (checked.has(index)) continue;
        checked.add(index);
        if (titleCited(reference, titles[index])) yield index;
      }
    }
  };
}
