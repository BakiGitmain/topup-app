// verify-payment: the order flavour of the shared verify handler (see ../_shared/verifyHandler.ts, which holds the logic
// and is also used by verify-deposit). Kept as its own module so the function's wiring and tests read the same as before.
import { createVerifyHandler, ORDER_KIND, type Deps } from '../_shared/verifyHandler.ts';

export type { Answer, BeginResult, Deps, FinishResult } from '../_shared/verifyHandler.ts';

export const createHandler = (deps: Deps) => createVerifyHandler(deps, ORDER_KIND);
