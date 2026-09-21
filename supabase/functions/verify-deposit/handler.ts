// verify-deposit: the deposit flavour of the shared verify handler (see ../_shared/verifyHandler.ts). Same ShegerPay logic as
// verify-payment; the only differences are the database functions it calls and the words it uses for statuses.
import { createVerifyHandler, DEPOSIT_KIND, type Deps } from '../_shared/verifyHandler.ts';

export type { Answer, BeginResult, Deps, FinishResult } from '../_shared/verifyHandler.ts';

export const createHandler = (deps: Deps) => createVerifyHandler(deps, DEPOSIT_KIND);
