import type { Argument } from "../model/types";

/**
 * Word completion for flowing.
 *
 * A round moves faster than anyone can spell, so the editor finishes the word
 * being typed and offers it as ghost text; Tab takes it, every other key
 * ignores it. This is a keystroke saver, not an expander — it completes a word
 * to a longer word, never shorthand into prose. What goes on the sheet is
 * still whatever the flower would have written.
 *
 * Two sources feed one keystroke: the standing debate vocabulary below, and
 * the words already on this flow. The second is what makes it learn a round's
 * own names — the aff's plan, the K's author, the acronym the 1NC invented —
 * with nobody maintaining a list.
 */

/** No suggestion until this many characters are typed; below it, everything matches. */
const MIN_PREFIX = 2;

/** What counts as part of a word, for both harvesting and completing. */
const WORD_CHAR = /[A-Za-z'-]/;
const WORD = /[A-Za-z][A-Za-z'-]{2,}/g;

/**
 * The vocabulary every round shares. Kept to words long enough that finishing
 * them is worth a keypress — the short ones are already shorthand.
 */
export const DEBATE_WORDS: string[] = [
  "advantage",
  "affirmative",
  "alternative",
  "authority",
  "brightline",
  "circumvention",
  "compliance",
  "conditionality",
  "counterplan",
  "credibility",
  "deference",
  "deterrence",
  "disadvantage",
  "discourse",
  "dispositional",
  "econ",
  "elections",
  "escalation",
  "existential",
  "extinction",
  "extratopicality",
  "extend",
  "framework",
  "hegemony",
  "heuristic",
  "impact",
  "inherency",
  "interpretation",
  "intervention",
  "irreversible",
  "jurisdiction",
  "kritik",
  "leadership",
  "legitimacy",
  "limits",
  "linear",
  "meltdown",
  "methodology",
  "mitigate",
  "modeling",
  "multilateral",
  "nonunique",
  "normative",
  "offense",
  "ontology",
  "overview",
  "perception",
  "permutation",
  "plausible",
  "precedent",
  "preclusion",
  "prerequisite",
  "presumption",
  "proliferation",
  "reasonability",
  "reciprocity",
  "resolution",
  "reversible",
  "rollback",
  "sequencing",
  "severance",
  "solvency",
  "sustainable",
  "systemic",
  "terminal",
  "threshold",
  "timeframe",
  "topicality",
  "tradeoff",
  "turncase",
  "uniqueness",
  "unilateral",
  "utilitarian",
  "warrant",
  "withdrawal",
];

/** Lower-cased word → how strongly to prefer it. Higher wins. */
export type Dictionary = Map<string, number>;

/**
 * Weigh the flow's own words above the standing vocabulary, and words the
 * round keeps coming back to above the ones it mentioned once.
 */
export function buildDictionary(
  texts: Iterable<string>,
  extra: Iterable<string> = [],
): Dictionary {
  const dict: Dictionary = new Map();
  for (const word of DEBATE_WORDS) dict.set(word.toLowerCase(), 1);
  // A user's own list is worth more than the generic vocabulary, less than
  // what this round is visibly about.
  for (const word of extra) dict.set(word.toLowerCase(), 2);
  for (const text of texts) {
    for (const match of text.matchAll(WORD)) {
      const word = match[0].toLowerCase();
      dict.set(word, Math.max(dict.get(word) ?? 0, 2) + 1);
    }
  }
  return dict;
}

/**
 * The word being typed at `caret`, or null if the caret isn't at the end of
 * one. Completing from the middle of a word would suggest replacing text the
 * user can see and didn't ask about.
 */
export function wordAt(
  text: string,
  caret: number,
): { start: number; word: string } | null {
  if (caret < text.length && WORD_CHAR.test(text[caret])) return null;
  let start = caret;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  const word = text.slice(start, caret);
  return word.length >= MIN_PREFIX ? { start, word } : null;
}

/**
 * What to append to finish the word at the caret — the *rest* of it, so the
 * caller can show it as ghost text and accept it by insertion. Null when
 * nothing is worth suggesting.
 */
export function completionAt(
  text: string,
  caret: number,
  dict: Dictionary,
): string | null {
  const at = wordAt(text, caret);
  if (!at) return null;

  const prefix = at.word.toLowerCase();
  let best: string | null = null;
  let bestWeight = 0;
  for (const [word, weight] of dict) {
    if (word.length <= prefix.length || !word.startsWith(prefix)) continue;
    // Heavier first; between equals, the shorter word — it's the one more
    // likely finished by the next keystroke anyway.
    if (
      weight > bestWeight ||
      (weight === bestWeight && best !== null && word.length < best.length)
    ) {
      best = word;
      bestWeight = weight;
    }
  }
  // Keep the case the user typed and only add what's missing.
  return best && best.slice(prefix.length);
}

/** Every piece of text on a flow, for `buildDictionary`. */
export function textsOf(roots: Argument[]): string[] {
  const out: string[] = [];
  const walk = (n: Argument) => {
    out.push(n.text);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}
