/**
 * The one way scripts talk to FazerCards: a client wrapped so it can only READ.
 * Anything that could order, buy, create or change state throws.
 * The key comes from the environment and is never printed.
 */
import { FazerCardsClient } from 'fazercards';

const apiKey = process.env.FAZER_API_KEY;
if (!apiKey) {
  console.error('FAZER_API_KEY is not set. Run with: node --env-file=.env scripts/<script>.ts');
  process.exit(1);
}

const FORBIDDEN = /^(order|buy\w*|create|set|test|delete|remove|update|wait)$/i;

function readOnly<T extends object>(target: T, path = 'fz'): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop !== 'string') return value;
      if (typeof value === 'function') {
        if (FORBIDDEN.test(prop)) throw new Error(`BLOCKED: ${path}.${prop}() is not read-only`);
        return value.bind(obj);
      }
      if (value && typeof value === 'object') return readOnly(value as object, `${path}.${prop}`);
      return value;
    },
  });
}

export const fz = readOnly(new FazerCardsClient({ apiKey, appName: 'topup-catalog-scan/0.1' }));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
