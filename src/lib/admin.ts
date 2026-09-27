import { catalogErrorMessage } from './adminCatalog';
import type { Category, GlyphKind } from './catalog';
import type { ActiveChanges } from './manageCatalog';
import { classifyOrderQuery, idStartsWith } from './orderView';
import { ORDER_COLUMNS, toOrder, type Order, type OrderRow } from './orders';
import { supabase } from './supabase';

// Everything here relies on the database's admin rules. The app hides these
// screens from customers, but a customer calling these would simply be refused.

/** Turns a database error code into something an admin can act on. */
export function adminErrorMessage(error: unknown): string {
  const catalog = catalogErrorMessage(error);
  if (catalog) return catalog;
  const message = (error as { message?: string } | null)?.message ?? '';
  if (message.includes('code_required')) return 'Paste the code first.';
  if (message.includes('invalid_transition')) return 'This order was already updated. Pull to refresh.';
  if (message.includes('code_already_delivered')) return "The code was already delivered, so it can't be refunded.";
  if (message.includes('insufficient_balance')) return 'That would take the balance below zero.';
  if (message.includes('forbidden')) return "You don't have admin access.";
  if (message.includes('creator_not_content_creator')) return "That person isn't a content creator. Turn that on for them first, then assign the code.";
  if (message.includes('discount_codes_discount_percent_check')) return 'The discount must be more than 0% and at most 90% (a 100% code could zero out an order, which cannot be paid).';
  if (message.includes('discount_codes_commission_percent_check')) return 'The commission must be between 0% and 100%.';
  if (message.includes('discount_codes_products_not_empty')) return 'Pick at least one product, or leave it open to every product.';
  if (message.includes('discount_codes_code_ci_idx') || message.includes('discount_codes_code_key')) return "That code is already in use (codes aren't case-sensitive, so SAVE10 and save10 are the same code).";
  if (message.includes('not_updated')) return "That change wasn't saved. You may not have admin access, or the code was removed. Pull to refresh and try again.";
  if (message.includes('row-level security') || message.includes('permission denied')) return "You don't have admin access.";
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------- queue

export type QueueFilter = 'pending' | 'processing' | 'done' | 'all';

export type QueueOrder = Order & {
  user_id: string;
  customerName: string;
  customerEmail: string;
};

type QueueRow = OrderRow & {
  user_id: string;
  profiles: { display_name: string; email: string | null } | null;
};

const QUEUE_COLUMNS = `${ORDER_COLUMNS}, user_id, profiles ( display_name, email )`;

function toQueueOrder(row: QueueRow): QueueOrder {
  return {
    ...toOrder(row),
    user_id: row.user_id,
    customerName: row.profiles?.display_name || row.profiles?.email || 'Customer',
    customerEmail: row.profiles?.email ?? '',
  };
}

/** Oldest first for open work (so the longest wait is on top), newest first otherwise. */
export async function fetchQueue(filter: QueueFilter): Promise<QueueOrder[]> {
  // Never a gift or redeem-code order (orders.gift_kind): those are delivered only when the gift is claimed, never
  // worked by hand, and the database refuses to move them anyway. Order search below still finds them.
  const base = supabase.from('orders').select(QUEUE_COLUMNS).is('gift_kind', null);
  const request =
    // 'paid' (bank transfer or instant wallet payment) is an equally valid, un-worked-on order, same as 'pending'
    // (the older direct-purchase path's default status) -- both show here, admin_deliver_order accepts either.
    filter === 'pending'
      ? base.in('status', ['pending', 'paid']).order('created_at', { ascending: true }).limit(100)
      : filter === 'processing'
        ? base.eq('status', 'processing').order('created_at', { ascending: true }).limit(100)
        : filter === 'done'
          ? base
              .in('status', ['completed', 'failed', 'refunded'])
              .order('created_at', { ascending: false })
              .limit(60)
          : base.order('created_at', { ascending: false }).limit(100);

  const { data, error } = await request;
  if (error) throw error;
  return ((data ?? []) as unknown as QueueRow[]).map(toQueueOrder);
}

/**
 * Finds orders by a full id, the start of an id ("#1A2B3C4D"), or a payment reference, newest first. An id prefix can't be
 * matched by the database on a uuid column, so the most recent 300 orders are read and matched here. Read-only; admins only (row security).
 */
export async function searchOrders(text: string): Promise<QueueOrder[]> {
  const q = classifyOrderQuery(text);
  if (!q) return [];
  const found = new Map<string, QueueOrder>();
  const add = (rows: unknown) => {
    for (const row of (rows ?? []) as QueueRow[]) found.set(row.id, toQueueOrder(row));
  };

  if (q.uuid) {
    const { data, error } = await supabase.from('orders').select(QUEUE_COLUMNS).eq('id', q.uuid).limit(1);
    if (error) throw error;
    add(data);
  }
  if (q.reference) {
    const { data, error } = await supabase.from('orders').select(QUEUE_COLUMNS).eq('payment_reference', q.reference).limit(5);
    if (error) throw error;
    add(data);
  }
  if (q.prefix && !q.uuid) {
    const { data, error } = await supabase.from('orders').select(QUEUE_COLUMNS).order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    add(((data ?? []) as unknown as QueueRow[]).filter((row) => idStartsWith(row.id, q.prefix as string)));
  }
  return [...found.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);
}

export type PaymentAttempt = {
  id: string;
  provider: string;
  reference: string;
  outcome: string;
  verified_amount: number | string | null;
  mode: string | null;
  http_status: number | null;
  created_at: string;
};

/** Every verification attempt for one order, oldest first: what ShegerPay said each time. Admin-only table. */
export async function fetchPaymentAttempts(orderId: string): Promise<PaymentAttempt[]> {
  const { data, error } = await supabase
    .from('payment_attempts')
    .select('id, provider, reference, outcome, verified_amount, mode, http_status, created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PaymentAttempt[];
}

export async function fetchPendingCount(): Promise<number> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .is('gift_kind', null)
    .in('status', ['pending', 'paid']);
  if (error) throw error;
  return count ?? 0;
}

export async function setOrderStatus(
  orderId: string,
  status: 'processing' | 'failed' | 'refunded'
): Promise<void> {
  const { error } = await supabase.rpc('admin_set_order_status', {
    p_order_id: orderId,
    p_status: status,
  });
  if (error) throw error;
}

/** Marks the order delivered. Code orders need `code`, which goes to the customer's vault. */
export async function deliverOrder(orderId: string, code: string | null): Promise<void> {
  const { error } = await supabase.rpc('admin_deliver_order', {
    p_order_id: orderId,
    p_code: code,
  });
  if (error) throw error;
}

// -------------------------------------------------------------- catalog

export type AdminOption = {
  id: string;
  label: string;
  price: number;
  /** Struck-through price shown to customers. Null = none. */
  old_price: number | null;
  is_active: boolean;
  sort_order: number;
  group_label: string | null;
  region_id: string | null;
  region_locked: boolean;
  account_region_codes: string[];
  /** The pack's card image (one of the product's gallery images), or null for the text-only card. */
  image_url: string | null;
  category_id: string | null;
  /** The supplier stopped listing this offer. The pack stays on sale and fails at order time. */
  missing_upstream: boolean;
  /** What the pack costs us in USD (admin-only). Null for packs not linked to a supplier. */
  supplier_cost_usd: number | null;
};

export type AdminRegion = {
  id: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  /** 'supplier' = the server checks the ID; 'none' = the customer ticks a box. */
  id_validation: 'supplier' | 'none';
  field_count: number;
};

export type AdminImage = { id: string; path: string; url: string; uploaded_at: string };
export type AdminCategory = { id: string; label: string; sort_order: number };

export type AdminProduct = {
  id: string;
  name: string;
  category: Category;
  tagline: string;
  glyph: GlyphKind;
  tint: string;
  image_url: string | null;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  options: AdminOption[];
  regions: AdminRegion[];
  images: AdminImage[];
  categories: AdminCategory[];
};

type SupplierEmbed = { missing_upstream: boolean; supplier_cost_usd: number | string | null };

type AdminOptionRow = Omit<AdminOption, 'price' | 'old_price' | 'missing_upstream' | 'supplier_cost_usd' | 'account_region_codes'> & {
  price: number | string;
  old_price: number | string | null;
  account_region_codes: string[] | null;
  product_option_supplier: SupplierEmbed | SupplierEmbed[] | null;
};

type AdminRegionRow = Omit<AdminRegion, 'field_count' | 'id_validation'> & {
  buyer_fields: unknown;
  id_validation: string;
};

type AdminProductRow = Omit<AdminProduct, 'options' | 'regions' | 'images' | 'categories'> & {
  product_options: AdminOptionRow[] | null;
  product_regions: AdminRegionRow[] | null;
  product_images: { id: string; path: string; uploaded_at: string }[] | null;
  product_categories: AdminCategory[] | null;
};

/** The public address of a file in the product-art bucket. */
export const artworkUrl = (path: string) => supabase.storage.from('product-art').getPublicUrl(path).data.publicUrl;

// One literal (not concatenated) so the Supabase client can read it as a select string.
const ADMIN_PRODUCT_COLUMNS =
  'id, name, category, tagline, glyph, tint, image_url, description, is_active, sort_order, product_options ( id, label, price, old_price, is_active, sort_order, group_label, region_id, region_locked, account_region_codes, image_url, category_id, product_option_supplier ( missing_upstream, supplier_cost_usd ) ), product_regions ( id, code, label, buyer_fields, id_validation, sort_order, is_active ), product_images ( id, path, uploaded_at ), product_categories ( id, label, sort_order )';

function toAdminProduct(row: AdminProductRow): AdminProduct {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    tagline: row.tagline,
    glyph: row.glyph,
    tint: row.tint,
    image_url: row.image_url,
    description: row.description,
    is_active: row.is_active,
    sort_order: row.sort_order,
    options: (row.product_options ?? [])
      .map((option) => {
        const supplier = Array.isArray(option.product_option_supplier) ? option.product_option_supplier[0] : option.product_option_supplier;
        return {
          id: option.id,
          label: option.label,
          price: Number(option.price),
          old_price: option.old_price === null ? null : Number(option.old_price),
          is_active: option.is_active,
          sort_order: option.sort_order,
          group_label: option.group_label,
          region_id: option.region_id,
          region_locked: option.region_locked === true,
          account_region_codes: option.account_region_codes ?? [],
          image_url: option.image_url ?? null,
          category_id: option.category_id ?? null,
          missing_upstream: supplier?.missing_upstream === true,
          supplier_cost_usd: supplier?.supplier_cost_usd == null ? null : Number(supplier.supplier_cost_usd),
        };
      })
      .sort((a, b) => a.sort_order - b.sort_order),
    regions: (row.product_regions ?? [])
      .map((r) => ({
        id: r.id,
        code: r.code,
        label: r.label,
        is_active: r.is_active,
        sort_order: r.sort_order,
        id_validation: (r.id_validation === 'supplier' ? 'supplier' : 'none') as 'supplier' | 'none',
        field_count: Array.isArray(r.buyer_fields) ? r.buyer_fields.length : 0,
      }))
      .sort((a, b) => a.sort_order - b.sort_order),
    images: (row.product_images ?? [])
      .map((i) => ({ id: i.id, path: i.path, url: artworkUrl(i.path), uploaded_at: i.uploaded_at }))
      .sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at)),
    categories: [...(row.product_categories ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)),
  };
}

export async function fetchAdminProducts(): Promise<AdminProduct[]> {
  const { data, error } = await supabase
    .from('products')
    .select(ADMIN_PRODUCT_COLUMNS)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as AdminProductRow[]).map(toAdminProduct);
}

export async function fetchAdminProduct(id: string): Promise<AdminProduct | null> {
  const { data, error } = await supabase.from('products').select(ADMIN_PRODUCT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toAdminProduct(data as unknown as AdminProductRow) : null;
}

/**
 * Updates one row and CONFIRMS a row changed. A write the row-level rules block updates zero rows and
 * raises no error, so without this check a refused change looks like a success that snaps back.
 */
async function updateRow(
  table: 'products' | 'product_regions' | 'product_options',
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

export async function updateProduct(
  id: string,
  patch: { name?: string; tagline?: string; description?: string | null; image_url?: string | null }
): Promise<void> {
  await updateRow('products', id, patch);
}

/** Price and old price go in ONE update, so the database checks them together (old price must exceed price). */
export async function updateOption(
  id: string,
  patch: {
    label?: string;
    price?: number;
    old_price?: number | null;
    region_locked?: boolean;
    account_region_codes?: string[];
    image_url?: string | null;
    category_id?: string | null;
  }
): Promise<void> {
  await updateRow('product_options', id, patch);
}

export async function addOption(
  productId: string,
  label: string,
  price: number,
  sortOrder: number
): Promise<void> {
  const { error } = await supabase
    .from('product_options')
    .insert({ product_id: productId, label, price, sort_order: sortOrder, is_active: true });
  if (error) throw error;
}

// ------------------------------------------------------------ gallery, categories, remove, batch

/** Registers an uploaded file as one of the product's card images. */
export async function addProductImage(productId: string, path: string): Promise<void> {
  const { error } = await supabase.from('product_images').insert({ product_id: productId, path });
  if (error) throw error;
}

/**
 * Deletes an image row. Packs that used it lose their image (the database does that). The file in storage
 * is removed by the caller afterwards.
 */
export async function removeProductImage(imageId: string): Promise<void> {
  const { data, error } = await supabase.from('product_images').delete().eq('id', imageId).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

export async function addCategory(productId: string, label: string, sortOrder: number): Promise<void> {
  const { error } = await supabase.from('product_categories').insert({ product_id: productId, label, sort_order: sortOrder });
  if (error) throw error;
}

export async function renameCategory(id: string, label: string): Promise<void> {
  const { data, error } = await supabase.from('product_categories').update({ label }).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

/** Refused by the database while packs are still in it: move them to another category first. */
export async function deleteCategory(id: string): Promise<void> {
  const { data, error } = await supabase.from('product_categories').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

/**
 * Removes a product and everything under it, unless an order was ever placed for it (then the database refuses:
 * hide it instead). Returns the storage files that belonged to it so the caller can delete them.
 */
export async function deleteProduct(productId: string): Promise<{ image_url: string | null; image_paths: string[] }> {
  const { data, error } = await supabase.rpc('admin_delete_product', { p_product_id: productId });
  if (error) throw error;
  const result = (data ?? {}) as { image_url?: string | null; image_paths?: string[] };
  return { image_url: result.image_url ?? null, image_paths: result.image_paths ?? [] };
}

/** Saves many on/off switches in ONE request. All or nothing: if any is refused, none is applied. */
export async function applyActiveChanges(changes: ActiveChanges): Promise<number> {
  const { data, error } = await supabase.rpc('admin_apply_active_changes', { p_changes: changes });
  if (error) throw error;
  return typeof data === 'number' ? data : 0;
}

// ------------------------------------------------------------ customers

export type Customer = {
  id: string;
  display_name: string;
  email: string | null;
  role: 'user' | 'admin';
  created_at: string;
  balance: number;
  is_content_creator: boolean;
};

type CustomerRow = Omit<Customer, 'balance'> & {
  wallets: { balance: number | string } | { balance: number | string }[] | null;
};

function toCustomer(row: CustomerRow): Customer {
  const wallet = Array.isArray(row.wallets) ? row.wallets[0] : row.wallets;
  return {
    id: row.id,
    display_name: row.display_name,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
    balance: wallet ? Number(wallet.balance) : 0,
    is_content_creator: row.is_content_creator === true,
  };
}

const CUSTOMER_COLUMNS = 'id, display_name, email, role, created_at, is_content_creator, wallets ( balance )';

/** Search by email or name. Empty search lists the newest customers. */
export async function searchCustomers(text: string): Promise<Customer[]> {
  // Characters that would break out of the filter expression.
  const q = text.trim().replace(/[,()*%\\]/g, '');
  let request = supabase.from('profiles').select(CUSTOMER_COLUMNS);
  if (q) request = request.or(`email.ilike.*${q}*,display_name.ilike.*${q}*`);
  const { data, error } = await request.order('created_at', { ascending: false }).limit(40);
  if (error) throw error;
  return ((data ?? []) as unknown as CustomerRow[]).map(toCustomer);
}

export async function fetchCustomer(id: string): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select(CUSTOMER_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? toCustomer(data as unknown as CustomerRow) : null;
}

export async function fetchCustomerOrders(userId: string): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return ((data ?? []) as OrderRow[]).map(toOrder);
}

/** Adds (positive) or removes (negative) balance. Recorded in the customer's history. */
export async function adjustBalance(userId: string, amount: number, note: string): Promise<void> {
  const { error } = await supabase.rpc('admin_adjust_balance', {
    p_user_id: userId,
    p_amount: amount,
    p_note: note || null,
  });
  if (error) throw error;
}

/** Grants or revokes content-creator status. Does not touch role, wallet, or anything a creator can already do as a customer. */
export async function setContentCreator(userId: string, value: boolean): Promise<void> {
  const { error } = await supabase.rpc('admin_set_content_creator', { p_user_id: userId, p_value: value });
  if (error) throw error;
}

/** Every current content creator, for the "assign a creator" picker. */
export async function fetchContentCreators(): Promise<{ id: string; display_name: string; email: string | null }[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('is_content_creator', true)
    .order('display_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as { id: string; display_name: string; email: string | null }[];
}

// ------------------------------------------------------------ discount codes

export type DiscountCode = {
  id: string;
  code: string;
  creator_id: string;
  creatorName: string;
  discount_percent: number;
  commission_percent: number;
  /** null = every product. */
  applicable_products: string[] | null;
  active: boolean;
  created_at: string;
  /** null = never expires. */
  expires_at: string | null;
  /** Portal Coins a code-using order earns instead of the flat default. */
  portal_coin_bonus: number;
  /** How many times it has actually been redeemed (an order that reached 'completed'), and by how much. */
  redemptionCount: number;
  totalDiscount: number;
  totalCommission: number;
};

type DiscountCodeRow = {
  id: string;
  code: string;
  creator_id: string;
  discount_percent: number | string;
  commission_percent: number | string;
  applicable_products: string[] | null;
  active: boolean;
  created_at: string;
  expires_at: string | null;
  portal_coin_bonus: number;
  creator: { display_name: string } | { display_name: string }[] | null;
  code_redemptions: { discount_amount: number | string; commission_amount: number | string }[] | null;
};

const DISCOUNT_CODE_COLUMNS =
  'id, code, creator_id, discount_percent, commission_percent, applicable_products, active, created_at, expires_at, portal_coin_bonus, creator:profiles!creator_id ( display_name ), code_redemptions ( discount_amount, commission_amount )';

function toDiscountCode(row: DiscountCodeRow): DiscountCode {
  const creator = Array.isArray(row.creator) ? row.creator[0] : row.creator;
  const redemptions = row.code_redemptions ?? [];
  return {
    id: row.id,
    code: row.code,
    creator_id: row.creator_id,
    creatorName: creator?.display_name || 'Creator',
    discount_percent: Number(row.discount_percent),
    commission_percent: Number(row.commission_percent),
    applicable_products: row.applicable_products,
    active: row.active,
    created_at: row.created_at,
    expires_at: row.expires_at,
    portal_coin_bonus: Number(row.portal_coin_bonus),
    redemptionCount: redemptions.length,
    totalDiscount: redemptions.reduce((sum, r) => sum + Number(r.discount_amount), 0),
    totalCommission: redemptions.reduce((sum, r) => sum + Number(r.commission_amount), 0),
  };
}

export async function fetchDiscountCodes(): Promise<DiscountCode[]> {
  const { data, error } = await supabase.from('discount_codes').select(DISCOUNT_CODE_COLUMNS).order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as DiscountCodeRow[]).map(toDiscountCode);
}

export type DiscountCodeInput = {
  code: string;
  creator_id: string;
  discount_percent: number;
  commission_percent: number;
  /** null = open to every product. */
  applicable_products: string[] | null;
  /** null = never expires. */
  expires_at: string | null;
  /** Portal Coins a code-using order earns instead of the flat default. */
  portal_coin_bonus: number;
};

/** Whitelists exactly the real columns -- callers (the admin form's `validateCodeForm` result) can carry extra
 * fields like `ok: true`, and spreading those straight into the table caused every create to fail with a raw
 * "column ok does not exist" (surfaced to the admin as a generic "Something went wrong"). */
function discountCodeRow(input: DiscountCodeInput) {
  return {
    code: input.code.trim(),
    creator_id: input.creator_id,
    discount_percent: input.discount_percent,
    commission_percent: input.commission_percent,
    applicable_products: input.applicable_products,
    expires_at: input.expires_at,
    portal_coin_bonus: input.portal_coin_bonus,
  };
}

export async function createDiscountCode(input: DiscountCodeInput): Promise<void> {
  const { error } = await supabase.from('discount_codes').insert(discountCodeRow(input));
  if (error) throw error;
}

export async function updateDiscountCode(id: string, input: DiscountCodeInput & { active: boolean }): Promise<void> {
  const { data, error } = await supabase
    .from('discount_codes')
    .update({ ...discountCodeRow(input), active: input.active })
    .eq('id', id)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

/** The row list's one-tap on/off toggle -- doesn't touch any other field. */
export async function setDiscountCodeActive(id: string, active: boolean): Promise<void> {
  const { data, error } = await supabase.from('discount_codes').update({ active }).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

/** Every product's id and name, for the "restrict to specific products" picker. Not the heavy admin-product shape. */
export async function fetchProductPickerList(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from('products').select('id, name').order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as { id: string; name: string }[];
}

// ------------------------------------------------------------ wheel prizes

export type WheelPrizeRow = {
  id: string;
  label: string;
  discount_birr: number;
  weight: number;
  active: boolean;
  created_at: string;
};

export async function fetchWheelPrizes(): Promise<WheelPrizeRow[]> {
  const { data, error } = await supabase
    .from('wheel_prizes')
    .select('id, label, discount_birr, weight, active, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as { id: string; label: string; discount_birr: number | string; weight: number | string; active: boolean; created_at: string }[]).map(
    (row) => ({ ...row, discount_birr: Number(row.discount_birr), weight: Number(row.weight) })
  );
}

export type WheelPrizeInput = { label: string; discount_birr: number; weight: number };

export async function createWheelPrize(input: WheelPrizeInput): Promise<void> {
  const { error } = await supabase.from('wheel_prizes').insert(input);
  if (error) throw error;
}

export async function updateWheelPrize(id: string, input: WheelPrizeInput): Promise<void> {
  const { data, error } = await supabase.from('wheel_prizes').update(input).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

export async function setWheelPrizeActive(id: string, active: boolean): Promise<void> {
  const { data, error } = await supabase.from('wheel_prizes').update({ active }).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

// ------------------------------------------------------------ wheel spin packages

export type WheelSpinPackageRow = {
  id: string;
  spins_count: number;
  portal_coin_cost: number;
  active: boolean;
  sort_order: number;
  created_at: string;
};

export async function fetchWheelSpinPackages(): Promise<WheelSpinPackageRow[]> {
  const { data, error } = await supabase
    .from('wheel_spin_packages')
    .select('id, spins_count, portal_coin_cost, active, sort_order, created_at')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as WheelSpinPackageRow[];
}

export type WheelSpinPackageInput = { spins_count: number; portal_coin_cost: number; sort_order: number };

export async function createWheelSpinPackage(input: WheelSpinPackageInput): Promise<void> {
  const { error } = await supabase.from('wheel_spin_packages').insert(input);
  if (error) throw error;
}

export async function updateWheelSpinPackage(id: string, input: WheelSpinPackageInput): Promise<void> {
  const { data, error } = await supabase.from('wheel_spin_packages').update(input).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

export async function setWheelSpinPackageActive(id: string, active: boolean): Promise<void> {
  const { data, error } = await supabase.from('wheel_spin_packages').update({ active }).eq('id', id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('not_updated');
}

