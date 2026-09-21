/**
 * ONE read-only player-id validation, to learn the real response shape.
 *   node --env-file=.env scripts/fazer-validate-id.ts <validation_category_id> key=value [key=value ...]
 * e.g. node --env-file=.env scripts/fazer-validate-id.ts free_fire player_id=123
 */
import { fz } from './fazer-client.ts';

const [categoryId, ...pairs] = process.argv.slice(2);
if (!categoryId || pairs.length === 0) {
  console.error('usage: fazer-validate-id.ts <category_id> key=value ...');
  process.exit(1);
}
const fields = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));

try {
  const started = Date.now();
  const result = await fz.topups.validateId({ categoryId, fields });
  console.log(JSON.stringify({ ok: true, ms: Date.now() - started, response: result }, null, 2));
} catch (err) {
  const e = err as { name?: string; status?: number; code?: string; message?: string };
  // Status and code only. The response body is not printed.
  console.log(JSON.stringify({ ok: false, error: e.name, status: e.status, code: e.code, message: String(e.message).slice(0, 120) }, null, 2));
}
