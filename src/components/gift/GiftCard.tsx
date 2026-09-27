import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../art/FeatherIcon';
import { Avatar } from '../market/Avatar';
import { ProductArt } from '../market/ProductArt';
import { IdForm } from '../product/IdForm';
import { Button } from '../ui/Button';
import { needsAccountId, type Category } from '../../lib/catalog';
import { claimErrorOf, claimGift } from '../../lib/giftClaim';
import { useT } from '../../lib/i18n';
import { isFieldsComplete, normalizeFields, type BuyerField } from '../../lib/idValidation';
import { packageState } from '../../lib/regionMatch';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, radius, shadow, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useIdValidation } from '../../lib/useIdValidation';
import type { VaultGift } from '../../lib/vault';
import { daysLeft } from '../../lib/vaultView';

/**
 * A received gift in the Vault. The shop's own product art (ProductArt) and the product page's own ID form and check
 * (IdForm + useIdValidation, the same rules checkout applies) -- what makes it a gift is only a small "Gift" badge and
 * who it is from. Claim: claim_gift, then the ordinary delivery step; the result is the normal order screen.
 */
export function GiftCard({ gift, onChanged }: { gift: VaultGift; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const pending = gift.status === 'pending';

  // What this pack needs to be delivered: the region's own fields, or, for an old region-less game pack, one game ID.
  const fields: BuyerField[] = gift.regionId
    ? gift.buyerFields
    : needsAccountId(gift.category as Category)
      ? [{ key: 'account_id', label: t('product.gameId'), type: 'text' }]
      : [];
  const idMode: 'supplier' | 'tick' | 'none' = gift.regionId && gift.idValidation === 'supplier' ? 'supplier' : fields.length > 0 ? 'tick' : 'none';

  const [values, setValues] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { check, retry } = useIdValidation({ regionId: gift.regionId, buyerFields: fields, values, enabled: pending && idMode === 'supplier' });

  const accountRegion = check.kind === 'valid' ? check.accountRegion : null;
  const pack = packageState(
    { regionLocked: gift.regionLocked, accountRegionCodes: gift.accountRegionCodes },
    { idMode, validated: check.kind === 'valid', accountRegion }
  );
  const wrongRegion = idMode === 'supplier' && check.kind === 'valid' && (pack === 'wrong_region' || pack === 'region_unknown');
  const ready =
    pending &&
    isFieldsComplete(fields, values) &&
    (idMode === 'supplier' ? check.kind === 'valid' && pack === 'ok' : idMode === 'tick' ? ticked : true);

  async function claim() {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await claimGift(gift.id, fields.length > 0 ? normalizeFields(fields, values) : {});
      toast(t(result.delivery === 'delivered' ? 'vault.gift.deliveredToast' : 'vault.gift.queued'));
      onChanged();
      // The same "here is your order" screen a normal purchase shows (receipt, and the code is in the Vault).
      router.push({ pathname: '/order/[id]', params: { id: result.deliveryOrderId } });
    } catch (err) {
      setProblem(t(`vault.claimErr.${claimErrorOf(err)}` as StringKey));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const days = daysLeft(gift.expiresAt);
  const from = gift.fromCode ? t('vault.gift.fromCode') : t('vault.gift.from', { name: gift.senderName ?? '…' });
  const stateLine = pending
    ? days <= 1
      ? t('vault.gift.claimToday')
      : t('vault.gift.claimWithin', { n: String(days) })
    : gift.status === 'expired'
      ? t('vault.gift.expired')
      : gift.deliveryStatus === 'completed'
        ? t('vault.gift.delivered')
        : t('vault.gift.delivering');

  return (
    <View style={[styles.card, shadow.lift, !pending && styles.cardDone]} accessibilityLabel={`${t('vault.gift.badge')}. ${gift.productName} ${gift.optionLabel}. ${from}. ${stateLine}`}>
      <View style={styles.head}>
        <ProductArt name={gift.productName} imageUrl={gift.imageUrl} tint={gift.tint} size={60} />
        <View style={styles.headText}>
          <View style={styles.badge}>
            <FeatherIcon name="gift" size={12} color={colors.limeDark} strokeWidth={2.4} />
            <Text style={styles.badgeText}>{t('vault.gift.badge')}</Text>
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {gift.productName}
          </Text>
          <Text style={styles.pack} numberOfLines={2}>
            {gift.regionLabel ? `${gift.optionLabel} · ${gift.regionLabel}` : gift.optionLabel}
          </Text>
        </View>
      </View>

      <View style={styles.fromRow}>
        {!gift.fromCode && <Avatar name={gift.senderName ?? '?'} uri={gift.senderAvatar} size={24} />}
        <Text style={styles.from} numberOfLines={1}>
          {from}
        </Text>
        <Text style={[styles.state, gift.status === 'expired' && styles.stateExpired]} numberOfLines={1}>
          {stateLine}
        </Text>
      </View>

      {pending && fields.length > 0 && (
        <View style={styles.idBox}>
          <Text style={styles.idTitle}>{gift.idSectionTitle ?? t('product.idTitle')}</Text>
          <IdForm
            fields={fields}
            values={values}
            onChange={(key, value) => {
              setValues((v) => ({ ...v, [key]: value }));
              setProblem(null);
            }}
            mode={idMode}
            check={check}
            onRetry={retry}
            ticked={ticked}
            onTick={setTicked}
            hint={gift.idSectionHint ?? t('product.gameIdHint')}
          />
        </View>
      )}

      {wrongRegion && <Text style={styles.problem}>{t('vault.gift.regionWrong', { region: accountRegion ?? '?' })}</Text>}
      {problem !== null && (
        <Text style={styles.problem} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      )}

      {pending && <Button label={t('vault.gift.claim')} icon="gift" onPress={claim} loading={busy} disabled={!ready} style={styles.action} />}
      {gift.status === 'claimed' && gift.deliveryOrderId && (
        <Button
          label={t('vault.gift.view')}
          variant="outline"
          onPress={() => router.push({ pathname: '/order/[id]', params: { id: gift.deliveryOrderId as string } })}
          style={styles.action}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.md, borderRadius: radius.xl, backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.limeSoft },
  cardDone: { borderColor: colors.border, opacity: 0.85 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headText: { flex: 1, minWidth: 0 },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.limeSoft,
    marginBottom: 4,
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', color: colors.limeDark },
  name: { fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  pack: { marginTop: 1, fontFamily: fonts.medium, fontSize: 13.5, color: colors.textMuted },
  fromRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  from: { flex: 1, minWidth: 0, fontFamily: fonts.medium, fontSize: 13.5, color: colors.text },
  state: { flexShrink: 0, fontFamily: fonts.medium, fontSize: 12, color: colors.textFaint },
  stateExpired: { color: colors.danger },
  idBox: { marginTop: spacing.md },
  idTitle: { marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  problem: { marginTop: spacing.sm, fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 19, color: colors.danger },
  action: { marginTop: spacing.md },
});
