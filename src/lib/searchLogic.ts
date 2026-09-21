/**
 * Search rules shared by the screens. Pure, no imports (Node tests it directly).
 *
 * TWO DIFFERENT DELAYS, on purpose:
 *  - Searches that ask the SERVER (the admin catalog import, the customer list) wait until the person has stopped typing for
 *    SEARCH_IDLE_MS, so a fast typist sends one request, not one per key.
 *  - The customer shop search filters the product list that is ALREADY on the phone: it makes no request at all, so there is
 *    no server to protect and waiting would only make it feel slower. It reacts at once (SHOP_SEARCH_IDLE_MS = 0). Set it to
 *    SEARCH_IDLE_MS if you want the shop to wait as well; nothing else has to change.
 */

/** How long typing must pause before a server search is sent. */
export const SEARCH_IDLE_MS = 1500;
/** The shop searches locally, so it does not wait. */
export const SHOP_SEARCH_IDLE_MS = 0;

/** Lower-case, accents removed, anything that is not a letter or digit turned into a space. "Free-Fire!" -> "free fire". */
export function normalizeSearchText(text: string): string {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words of a query (at most 5, repeats dropped). "  Fire  free " -> ["fire","free"]. */
export function searchTokens(query: string): string[] {
  return [...new Set(normalizeSearchText(query).split(' ').filter(Boolean))].slice(0, 5);
}

/** What people type to mean each kind of product, besides its own name. Only obvious words: nothing here is a product name. */
const CATEGORY_WORDS: Record<string, string> = {
  games: 'game games top up topup',
  'gift-cards': 'gift card cards giftcard giftcards',
  'game-keys': 'game key keys',
  subscriptions: 'subscription subscriptions membership',
};

export type Searchable = { name: string; tagline: string; category: string };

/**
 * Products matching EVERY word of the query, in any order, in the name, the tagline or the kind of product ("gift card",
 * "keys", "subscription", "game"): so "fire free", "gift" and "sub" all find things, across every kind of product. Best
 * matches first: a word that starts the name or one of its words beats a match inside the tagline. Airtime is never browsable.
 */
export function searchProducts<T extends Searchable>(products: readonly T[], query: string): T[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];

  const scored: { product: T; score: number; index: number }[] = [];
  products.forEach((product, index) => {
    if (product.category === 'airtime') return;
    const name = normalizeSearchText(product.name);
    const nameWords = name.split(' ');
    const tagline = normalizeSearchText(product.tagline);
    const kind = CATEGORY_WORDS[product.category] ?? '';

    let score = 0;
    for (const token of tokens) {
      if (nameWords.some((w) => w.startsWith(token))) score += 4;
      else if (name.includes(token)) score += 3;
      else if (tagline.includes(token)) score += 2;
      else if (kind.includes(token)) score += 1;
      else return; // every word must match somewhere
    }
    if (name.startsWith(tokens[0])) score += 2;
    scored.push({ product, score, index });
  });

  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.product);
}
