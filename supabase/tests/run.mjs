// Runs every database test file: `npm run test:db`
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let failed = false;
for (const file of ['wallet.test.mjs', 'catalog.test.mjs', 'purchase.test.mjs', 'rules-vs-scan.test.mjs', 'region-match.test.mjs', 'validation.test.mjs', 'import.test.mjs', 'seed-cache.test.mjs', 'cleanup.test.mjs', 'manage.test.mjs', 'payments.test.mjs', 'wallet-requests.test.mjs', 'region-alias.test.mjs', 'payment-tutorials.test.mjs', 'testdata.test.mjs', 'suppliers.test.mjs', 'discount-codes.test.mjs', 'portal-coin.test.mjs', 'wheel.test.mjs', 'auth.test.mjs', 'notifications.test.mjs', 'gifts.test.mjs', 'gift-checkout.test.mjs', 'gift-delivery.test.mjs', 'gift-security.test.mjs', 'gift-server.test.mjs', 'gift-notify.test.mjs', 'region-order.test.mjs']) {
  console.log(`\n=========== ${file}`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
