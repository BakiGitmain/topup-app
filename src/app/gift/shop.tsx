import { Redirect, useLocalSearchParams } from 'expo-router';

import { ShopCatalog } from '../(customer)/shop';
import { useAuth } from '../../lib/auth';
import { readGiftParams, type GiftRouteParams } from '../../lib/giftMode';

/** The shop's own catalog, in gift mode (see ShopCatalog). Without valid gift params, it's just the shop. */
export default function GiftShopScreen() {
  const params = useLocalSearchParams<GiftRouteParams>();
  const { session, initializing } = useAuth();
  const gift = readGiftParams(params);
  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!gift) return <Redirect href="/gift" />;
  return <ShopCatalog gift={gift} />;
}
