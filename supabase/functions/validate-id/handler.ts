// The validate-id request handler, with every outside dependency injected so it can be tested
// without the network, the database or the supplier. index.ts wires the real ones.
import {
  CORS_HEADERS,
  UUID,
  checkFields,
  classifySupplierError,
  parseSupplierResult,
  toSupplierFields,
  type BuyerField,
} from '../_shared/validation.ts';

export type Target = {
  id_validation: string;
  buyer_fields: BuyerField[];
  validation_category_id: string | null;
  validation_field_map: unknown;
  /** Which supplier this region's ID check belongs to ('fazercards' | 'shop2topup'). Missing = fazercards (older rows). */
  supplier?: string | null;
};

export type Deps = {
  /** The user behind a bearer token, or null if the token is not valid. */
  getUserId: (token: string) => Promise<string | null>;
  /** false = this user is asking too often. */
  claimSlot: (userId: string) => Promise<boolean>;
  getTarget: (regionId: string) => Promise<Target | null>;
  /** Calls the supplier the region's pack data belongs to (`supplier`). Throws on any error. */
  supplierValidate: (categoryId: string, fields: Record<string, string>, supplier: string) => Promise<unknown>;
  record: (
    userId: string,
    regionId: string,
    fields: Record<string, string>,
    accountRegion: string | null,
    playerName: string | null
  ) => Promise<{ validation_id: string; valid_until: string }>;
  /** Structured events only. Never pass an ID, a name or a supplier body. */
  log: (event: Record<string, unknown>) => void;
  /** Our own limit on the supplier call, so a slow supplier can't hang the customer. */
  timeoutMs: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { status: null })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return json({ error: 'unauthorized' }, 401);

    let body: { region_id?: unknown; fields?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const regionId = typeof body?.region_id === 'string' && UUID.test(body.region_id) ? body.region_id : null;
    if (!regionId) return json({ error: 'bad_request' }, 400);

    if (!(await deps.claimSlot(userId))) {
      deps.log({ event: 'validate', outcome: 'throttled' });
      return json({ error: 'slow_down' }, 429);
    }

    const target = await deps.getTarget(regionId);
    if (!target || target.id_validation !== 'supplier' || !target.validation_category_id) {
      return json({ error: 'not_available' }, 404);
    }

    const checked = checkFields(target.buyer_fields, body.fields);
    if (!checked.ok) return json({ error: 'bad_fields', reason: checked.reason, key: checked.key }, 400);

    let result;
    try {
      result = await withTimeout(
        deps.supplierValidate(target.validation_category_id, toSupplierFields(checked.fields, target.validation_field_map), target.supplier ?? 'fazercards'),
        deps.timeoutMs
      );
    } catch (error) {
      const { outcome, status } = classifySupplierError(error);
      deps.log({ event: 'validate', outcome, supplier_status: status });
      return json({ status: outcome });
    }

    const parsed = parseSupplierResult(result);
    if (!parsed.valid) {
      deps.log({ event: 'validate', outcome: 'invalid', supplier_status: 200 });
      return json({ status: 'invalid' });
    }

    try {
      const saved = await deps.record(userId, regionId, checked.fields, parsed.accountRegion, parsed.playerName);
      deps.log({ event: 'validate', outcome: 'valid', region_reported: parsed.accountRegion !== null });
      return json({
        status: 'valid',
        validation_id: saved.validation_id,
        expires_at: saved.valid_until,
        // Relative, so a wrong clock on the phone can't make a fresh check look expired.
        expires_in: Math.max(0, Math.floor((Date.parse(saved.valid_until) - Date.now()) / 1000)),
        player_name: parsed.playerName,
        account_region: parsed.accountRegion,
      });
    } catch (error) {
      deps.log({ event: 'validate', outcome: 'record_failed', message: String((error as Error)?.message ?? '').slice(0, 80) });
      return json({ error: 'server_error' }, 500);
    }
  };
}
