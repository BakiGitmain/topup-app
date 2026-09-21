// Which supplier's ID check a region uses. A region's pack data is tagged with a supplier (product_region_supplier.supplier);
// the check MUST go to that same supplier, because the category id it holds only means something there ("free_fire_mena" is a
// FazerCards id, "4" is a Shop2Topup one). No tag (rows from before suppliers were named) means FazerCards. A supplier we don't
// know is "could not check" (503): it never falls back to another supplier, which would check the wrong game's IDs.
export type Validator = (categoryId: string, fields: Record<string, string>) => Promise<unknown>;

export const DEFAULT_SUPPLIER = 'fazercards';

export function routeValidation(validators: Record<string, Validator | undefined>) {
  return async function validate(categoryId: string, fields: Record<string, string>, supplier?: string | null): Promise<unknown> {
    const name = supplier === undefined || supplier === null || supplier === '' ? DEFAULT_SUPPLIER : supplier;
    const validator = Object.prototype.hasOwnProperty.call(validators, name) ? validators[name] : undefined;
    if (!validator) throw Object.assign(new Error('unknown supplier'), { status: 503 });
    return await validator(categoryId, fields);
  };
}
