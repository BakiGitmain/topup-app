import { supabase } from './supabase';

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  // Paid by Telebirr/CBE (see the cart and payment screens):
  | 'pending_payment'
  | 'paid'
  | 'payment_mismatch'
  | 'cancelled';
export type Fulfillment = 'topup' | 'code';

export type Order = {
  id: string;
  product_name: string;
  option_label: string;
  amount: number;
  status: OrderStatus;
  fulfillment: Fulfillment;
  /** What the customer entered: every ID field, plus the first as account_id. */
  delivery: { account_id?: string; fields?: Record<string, string> };
  region_label: string | null;
  /** The validation record this order was bought against, and what it said. Null when not validated. */
  validation_id: string | null;
  validated_account_region: string | null;
  validated_player_name: string | null;
  /** Set when the customer ticked "I've checked my ID" instead (a region that can't be validated). */
  id_self_declared_at: string | null;
  created_at: string;
  completed_at: string | null;
  /** How it was paid ('telebirr', 'cbe', 'wallet'), the bank transfer's reference, and when payment was confirmed. Null while unpaid. */
  payment_provider?: string | null;
  payment_reference?: string | null;
  paid_at?: string | null;
  /** Admin trail only: what ShegerPay verified, and whether the test key did it. */
  payment_verified_amount?: number | string | null;
  payment_mode?: string | null;
};

export const ORDER_COLUMNS =
  'id, product_name, option_label, amount, status, fulfillment, delivery, region_label, validation_id, validated_account_region, validated_player_name, id_self_declared_at, created_at, completed_at, payment_provider, payment_reference, paid_at, payment_verified_amount, payment_mode';

export type OrderRow = Omit<Order, 'amount'> & { amount: number | string };

export function toOrder(row: OrderRow): Order {
  return { ...row, amount: Number(row.amount), delivery: row.delivery ?? {} };
}

// Admins can read every order, so customer queries always filter by user id.

export async function fetchMyOrders(userId: string): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as OrderRow[]).map(toOrder);
}

export async function fetchOrder(userId: string, id: string): Promise<Order | null> {
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? toOrder(data as OrderRow) : null;
}

export type BuyAgainItem = {
  optionId: string;
  productId: string;
  productName: string;
  optionLabel: string;
  price: number;
  /** The game ID used last time, to pre-fill checkout. */
  accountId: string | null;
};

type BuyAgainRow = {
  product_name: string;
  option_label: string;
  delivery: { account_id?: string } | null;
  product_options: {
    id: string;
    product_id: string;
    price: number | string;
    is_active: boolean;
    products: { is_active: boolean } | null;
  } | null;
};

/** Last few distinct things this customer bought and could buy again. */
export async function fetchBuyAgain(userId: string, max = 3): Promise<BuyAgainItem[]> {
  const { data, error } = await supabase
    .from('orders')
    .select(
      'product_name, option_label, delivery, product_options ( id, product_id, price, is_active, products ( is_active ) )'
    )
    .eq('user_id', userId)
    .in('status', ['pending', 'processing', 'completed'])
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;

  const seen = new Set<string>();
  const items: BuyAgainItem[] = [];
  for (const row of (data ?? []) as unknown as BuyAgainRow[]) {
    const option = row.product_options;
    if (!option || !option.is_active || !option.products?.is_active) continue;
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    items.push({
      optionId: option.id,
      productId: option.product_id,
      productName: row.product_name,
      optionLabel: row.option_label,
      price: Number(option.price),
      accountId: row.delivery?.account_id ?? null,
    });
    if (items.length === max) break;
  }
  return items;
}

/** The ID fields this customer last used for a product, to pre-fill the form. Null if none. */
export async function fetchLastFields(userId: string, productId: string): Promise<Record<string, string> | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('delivery, product_options!inner ( product_id )')
    .eq('user_id', userId)
    .eq('product_options.product_id', productId)
    .eq('fulfillment', 'topup')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as { delivery: Order['delivery'] | null } | undefined;
  if (row?.delivery?.fields && Object.keys(row.delivery.fields).length > 0) return row.delivery.fields;
  return row?.delivery?.account_id ? { account_id: row.delivery.account_id } : null;
}

export { mismatchRegion, purchaseErrorKind, type PurchaseError } from './purchaseErrors';

/**
 * Charges the customer's balance and creates the order, in one database step. The client never
 * sends a price: the database charges the package's own. `idChecked` is the customer's tick for
 * regions the server can't validate; for the rest, the database wants a matching validation record.
 */
export async function purchase(
  optionId: string,
  fields: Record<string, string> | null,
  idChecked: boolean
): Promise<Order> {
  const { data, error } = await supabase.rpc('purchase_product_option', {
    p_option_id: optionId,
    p_delivery: fields ?? {},
    p_id_checked: idChecked,
  });
  if (error) throw error;
  return toOrder(data as OrderRow);
}

/** Orders still being worked on: the dot on the Orders tab. */
export async function fetchOpenOrderCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['pending', 'processing', 'pending_payment', 'paid', 'payment_mismatch']);
  if (error) throw error;
  return count ?? 0;
}
