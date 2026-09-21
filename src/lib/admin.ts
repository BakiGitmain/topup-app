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
  const base = supabase.from('orders').select(QUEUE_COLUMNS);
  const request =
    filter === 'pending'
      ? base.eq('status', 'pending').order('created_at', { ascending: true }).limit(100)
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
    .eq('status', 'pending');
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
  };
}

const CUSTOMER_COLUMNS = 'id, display_name, email, role, created_at, wallets ( balance )';

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
