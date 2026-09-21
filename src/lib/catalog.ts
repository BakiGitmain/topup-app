import { purchasablePackages, safeImageUrl } from './catalogRules';
import { supabase } from './supabase';

export type Category = 'games' | 'gift-cards' | 'game-keys' | 'subscriptions' | 'airtime';

/** Categories shown as sections on the home screen, in this order. */
export type BrowseCategory = 'games' | 'gift-cards' | 'game-keys' | 'subscriptions';
export const BROWSE_CATEGORIES: BrowseCategory[] = ['games', 'gift-cards', 'game-keys', 'subscriptions'];

export type GlyphKind =
  | 'diamond'
  | 'coin'
  | 'signal'
  | 'gift'
  | 'play'
  | 'crosshair'
  | 'controller';

export type Product = {
  id: string;
  name: string;
  category: Category;
  tagline: string;
  /** Artwork uploaded by an admin. Null shows a letter tile instead. */
  imageUrl: string | null;
  glyph: GlyphKind;
  /** Pale voucher background. */
  tint: string;
  featured?: boolean;
};

/**
 * Games (diamonds, UC...) are topped up to a player's game ID by an admin.
 * Everything else is delivered as a code into the customer's vault. The
 * database makes the same call from the category, so this only drives the UI.
 */
export function needsAccountId(category: Category) {
  return category === 'games' || category === 'airtime';
}

type OptionRow = {
  id: string;
  label: string;
  price: number | string;
  is_active: boolean;
  sort_order: number;
  region_id: string | null;
};
type RegionRow = { id: string; is_active: boolean };

type ProductRow = {
  id: string;
  name: string;
  category: Category;
  tagline: string;
  image_url: string | null;
  glyph: GlyphKind;
  tint: string;
  featured: boolean;
  product_options: OptionRow[] | null;
  product_regions: RegionRow[] | null;
};

// One literal (not concatenated) so the Supabase client can read it as a select string.
const PRODUCT_COLUMNS =
  'id, name, category, tagline, image_url, glyph, tint, featured, product_options ( id, label, price, is_active, sort_order, region_id ), product_regions ( id, is_active )';

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    tagline: row.tagline,
    imageUrl: safeImageUrl(row.image_url),
    glyph: row.glyph,
    tint: row.tint,
    featured: row.featured,
  };
}

/**
 * Active products with at least one active option. Prices live in
 * `product_options`, so admins change them without an app release.
 */
export async function fetchCatalog(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error) throw error;

  return ((data ?? []) as ProductRow[]).flatMap((row) =>
    purchasablePackages(row.product_options, row.product_regions).length === 0 ? [] : [toProduct(row)]
  );
}

// One implementation, shared with the admin preview. Re-exported so existing imports keep working.
export { formatBirr } from './pricing';
