import type { Category, GlyphKind } from './catalog';
import { purchasablePackages, safeImageUrl } from './catalogRules';
import type { BuyerField } from './idValidation';
import type { CategoryView, PackageView, RegionView } from './productView';
import { humanizeKey } from './productView';
import { supabase } from './supabase';

export type ProductDetail = {
  id: string;
  name: string;
  category: Category;
  tagline: string;
  imageUrl: string | null;
  /** Only ever what an admin wrote. Null shows nothing. */
  description: string | null;
  currencyLabel: string | null;
  glyph: GlyphKind;
  tint: string;
};

export type ProductPage = {
  product: ProductDetail;
  regions: RegionView[];
  packages: PackageView[];
  categories: CategoryView[];
};

type OptionRow = {
  id: string;
  label: string;
  price: number | string;
  old_price: number | string | null;
  group_label: string | null;
  region_id: string | null;
  region_locked: boolean;
  account_region_codes: string[] | null;
  sort_order: number;
  is_active: boolean;
  image_url: string | null;
  category_id: string | null;
};

type RegionRow = {
  id: string;
  code: string;
  label: string;
  buyer_fields: unknown;
  id_validation: string;
  sort_order: number;
  is_active: boolean;
};

type Row = {
  id: string;
  name: string;
  category: Category;
  tagline: string;
  image_url: string | null;
  description: string | null;
  currency_label: string | null;
  glyph: GlyphKind;
  tint: string;
  product_options: OptionRow[] | null;
  product_regions: RegionRow[] | null;
  product_categories: { id: string; label: string; sort_order: number }[] | null;
};

// One literal (not concatenated) so the Supabase client can read it as a select string.
const COLUMNS =
  'id, name, category, tagline, image_url, description, currency_label, glyph, tint, product_options ( id, label, price, old_price, group_label, region_id, region_locked, account_region_codes, sort_order, is_active, image_url, category_id ), product_regions ( id, code, label, buyer_fields, id_validation, sort_order, is_active ), product_categories ( id, label, sort_order )';

/** The form a region declares. Anything malformed is dropped rather than rendered. */
export function parseBuyerFields(raw: unknown): BuyerField[] {
  if (!Array.isArray(raw)) return [];
  const out: BuyerField[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const f = item as { key?: unknown; label?: unknown; type?: unknown; options?: unknown };
    if (typeof f.key !== 'string' || f.key === '') continue;
    const label = typeof f.label === 'string' && f.label.trim() !== '' ? f.label : humanizeKey(f.key);
    if (f.type === 'select' && Array.isArray(f.options)) {
      const options = f.options
        .filter((o): o is { label?: unknown; value: string } => o !== null && typeof o === 'object' && typeof (o as { value?: unknown }).value === 'string')
        .map((o) => ({ label: typeof o.label === 'string' ? o.label : o.value, value: o.value }));
      out.push({ key: f.key, label, type: 'select', options });
    } else {
      out.push({ key: f.key, label, type: 'text' });
    }
  }
  return out;
}

function toPage(row: Row): ProductPage | null {
  const regions = (row.product_regions ?? []).filter((r) => r.is_active);
  const live = purchasablePackages(row.product_options, row.product_regions);
  if (live.length === 0) return null;

  return {
    product: {
      id: row.id,
      name: row.name,
      category: row.category,
      tagline: row.tagline,
      imageUrl: safeImageUrl(row.image_url),
      description: row.description?.trim() ? row.description : null,
      currencyLabel: row.currency_label?.trim() ? row.currency_label : null,
      glyph: row.glyph,
      tint: row.tint,
    },
    regions: regions.map((r) => ({
      id: r.id,
      code: r.code,
      label: r.label,
      buyerFields: parseBuyerFields(r.buyer_fields),
      idValidation: r.id_validation === 'supplier' ? 'supplier' : 'none',
      sortOrder: r.sort_order,
    })),
    packages: live.map((o) => ({
      id: o.id,
      label: o.label,
      groupLabel: o.group_label,
      price: Number(o.price),
      oldPrice: o.old_price === null ? null : Number(o.old_price),
      regionId: o.region_id,
      regionLocked: o.region_locked === true,
      accountRegionCodes: o.account_region_codes ?? [],
      sortOrder: o.sort_order,
      imageUrl: safeImageUrl(o.image_url),
      categoryId: o.category_id ?? null,
    })),
    categories: (row.product_categories ?? []).map((c) => ({ id: c.id, label: c.label, sortOrder: c.sort_order })),
  };
}

/** One product with everything its page needs. Null when it is gone or has nothing to buy. */
export async function fetchProductPage(id: string): Promise<ProductPage | null> {
  const { data, error } = await supabase
    .from('products')
    .select(COLUMNS)
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data ? toPage(data as unknown as Row) : null;
}
