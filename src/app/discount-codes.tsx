import { Redirect, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  adminErrorMessage,
  createDiscountCode,
  fetchContentCreators,
  fetchDiscountCodes,
  fetchProductPickerList,
  setDiscountCodeActive,
  updateDiscountCode,
  type DiscountCode,
} from '../lib/admin';
import { formatBirr } from '../lib/catalog';
import { formatDate } from '../lib/format';
import { MAX_DISCOUNT_PERCENT, parsePercent, parsePortalCoinBonus, validateCodeForm, type CodeFormState } from '../lib/discountCodeForm';
import { useAuth } from '../lib/auth';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { useToast } from '../lib/toast';

import { Button } from '../components/ui/Button';
import { DateField } from '../components/ui/DateField';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { PillGroup } from '../components/ui/PillGroup';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { Toggle } from '../components/ui/Toggle';

const EMPTY_FORM = (): CodeFormState => ({
  code: '',
  creatorId: null,
  discountText: '',
  commissionText: '',
  portalCoinBonusText: '2',
  restrict: false,
  selectedProducts: new Set(),
  expiresAt: null,
});
const isExpired = (expiresAt: string | null) => expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();

/**
 * Admin: create, edit and deactivate discount codes. Assigning a creator, both percentages, and restricting a code
 * to specific products all live in one form -- open (create) or filled from an existing row (edit). Deactivating an
 * existing code is a one-tap toggle right on its row, since it needs no other field to change.
 */
export default function DiscountCodesScreen() {
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const allowed = !initializing && !!session && isAdmin;

  const codes = useAsync(fetchDiscountCodes, 0, allowed);
  const creators = useAsync(fetchContentCreators, 0, allowed);
  const products = useAsync(fetchProductPickerList, 0, allowed);

  const [editingId, setEditingId] = useState<string | null | 'new'>(null);
  const [editingActive, setEditingActive] = useState(true);
  const [form, setForm] = useState<CodeFormState>(EMPTY_FORM());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const creatorOptions = useMemo(() => (creators.data ?? []).map((c) => ({ id: c.id, label: c.display_name || c.email || 'Creator' })), [creators.data]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  const valid = validateCodeForm(form);
  const discountError = form.discountText.length > 0 && parsePercent(form.discountText, false, MAX_DISCOUNT_PERCENT) === null ? `Must be over 0 and at most ${MAX_DISCOUNT_PERCENT}` : null;
  const commissionError = form.commissionText.length > 0 && parsePercent(form.commissionText, true) === null ? 'Must be 0 to 100' : null;
  const coinBonusError = form.portalCoinBonusText.length > 0 && parsePortalCoinBonus(form.portalCoinBonusText) === null ? 'A whole number, at least 1' : null;

  function openNew() {
    setForm(EMPTY_FORM());
    setEditingActive(true);
    setError(null);
    setEditingId('new');
  }

  function openEdit(row: DiscountCode) {
    setForm({
      code: row.code,
      creatorId: row.creator_id,
      discountText: String(row.discount_percent),
      commissionText: String(row.commission_percent),
      portalCoinBonusText: String(row.portal_coin_bonus),
      restrict: row.applicable_products !== null,
      selectedProducts: new Set(row.applicable_products ?? []),
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    });
    setEditingActive(row.active);
    setError(null);
    setEditingId(row.id);
  }

  function closeForm() {
    setEditingId(null);
    setError(null);
  }

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editingId === 'new') {
        await createDiscountCode(valid);
        toast(`Code ${valid.code} created`);
      } else if (editingId) {
        await updateDiscountCode(editingId, { ...valid, active: editingActive });
        toast(`Code ${valid.code} saved`);
      }
      closeForm();
      await codes.reload();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: DiscountCode) {
    if (rowBusy) return;
    setRowBusy(row.id);
    try {
      await setDiscountCodeActive(row.id, !row.active);
      await codes.reload();
    } catch (err) {
      toast(adminErrorMessage(err));
    } finally {
      setRowBusy(null);
    }
  }

  function toggleProduct(id: string) {
    setForm((current) => {
      const next = new Set(current.selectedProducts);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...current, selectedProducts: next };
    });
  }

  const productNameOf = (id: string) => products.data?.find((p) => p.id === id)?.name ?? id;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title="Discount codes" onBack={() => (router.canGoBack() ? router.back() : router.replace('/me'))} />
          <Text style={styles.lead}>
            A code discounts a customer&rsquo;s FIRST order only, and credits its creator a commission on the whole order total. Assign codes only to people marked &ldquo;content creator&rdquo; on their customer page.
          </Text>

          {creators.status === 'ready' && (creators.data ?? []).length === 0 && (
            <ErrorBanner message="No content creators yet. Mark someone as a content creator on their customer page first." />
          )}

          {editingId === null && (
            <Button label="+ New code" onPress={openNew} disabled={(creators.data ?? []).length === 0} style={styles.newButton} />
          )}

          {editingId !== null && (
            <View style={styles.form}>
              <Text style={styles.formTitle}>{editingId === 'new' ? 'New code' : `Edit ${form.code}`}</Text>

              <TextField
                label="Code"
                value={form.code}
                onChangeText={(v) => setForm((c) => ({ ...c, code: v }))}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={40}
                editable={!busy}
              />

              <Text style={styles.fieldLabel}>Creator</Text>
              {creatorOptions.length > 0 ? (
                <PillGroup
                  label="Creator"
                  options={creatorOptions}
                  value={form.creatorId ?? ''}
                  onChange={(id) => setForm((c) => ({ ...c, creatorId: id }))}
                />
              ) : (
                <Text style={styles.empty}>No content creators available.</Text>
              )}

              <TextField
                label="Discount % (off the order, for the covered items)"
                value={form.discountText}
                onChangeText={(v) => setForm((c) => ({ ...c, discountText: v }))}
                keyboardType="decimal-pad"
                placeholder="10"
                editable={!busy}
                error={discountError}
              />
              <TextField
                label="Commission % (of the whole pre-discount order, credited to the creator)"
                value={form.commissionText}
                onChangeText={(v) => setForm((c) => ({ ...c, commissionText: v }))}
                keyboardType="decimal-pad"
                placeholder="5"
                editable={!busy}
                error={commissionError}
              />

              <TextField
                label="Portal Coin bonus (earned by an order that uses this code, instead of the usual +2)"
                value={form.portalCoinBonusText}
                onChangeText={(v) => setForm((c) => ({ ...c, portalCoinBonusText: v }))}
                keyboardType="number-pad"
                placeholder="2"
                editable={!busy}
                error={coinBonusError}
              />

              <DateField
                label="Expires on (optional)"
                value={form.expiresAt}
                onChange={(d) => setForm((c) => ({ ...c, expiresAt: d }))}
                placeholder="Never expires"
                minimumDate={new Date()}
                disabled={busy}
              />

              <View style={styles.restrictRow}>
                <Text style={styles.fieldLabel}>Restrict to specific products</Text>
                <Toggle
                  value={form.restrict}
                  onValueChange={(v) => setForm((c) => ({ ...c, restrict: v }))}
                  label="Restrict to specific products"
                  disabled={busy}
                />
              </View>
              {!form.restrict && <Text style={styles.hint}>Open to every product.</Text>}
              {form.restrict && (
                <View style={styles.productList}>
                  {products.status === 'loading' && <ActivityIndicator color={colors.limeDeep} />}
                  {(products.data ?? []).map((p) => (
                    <View key={p.id} style={styles.productRow}>
                      <Text style={styles.productName} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Toggle value={form.selectedProducts.has(p.id)} onValueChange={() => toggleProduct(p.id)} label={p.name} disabled={busy} />
                    </View>
                  ))}
                  {form.restrict && form.selectedProducts.size === 0 && <Text style={styles.hint}>Pick at least one product.</Text>}
                </View>
              )}

              {error && <ErrorBanner message={error} />}

              <View style={styles.formButtons}>
                <Button label="Cancel" variant="outline" onPress={closeForm} disabled={busy} style={styles.formButton} />
                <Button label="Save" onPress={save} loading={busy} disabled={!valid} style={styles.formButton} />
              </View>
            </View>
          )}

          <Text style={styles.section}>All codes</Text>
          {codes.status === 'loading' && !codes.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}
          {codes.status === 'error' && !codes.data && <ErrorBanner message="Couldn't load discount codes." />}
          {codes.data && codes.data.length === 0 && <Text style={styles.empty}>No discount codes yet.</Text>}

          {(codes.data ?? []).map((row) => (
            <View key={row.id} style={[styles.row, !row.active && styles.rowInactive]}>
              <View style={styles.rowHead}>
                <Text style={styles.rowCode} numberOfLines={1}>
                  {row.code}
                </Text>
                <Toggle value={row.active} onValueChange={() => toggleActive(row)} label={`${row.code} active`} disabled={rowBusy === row.id} />
              </View>
              <Text style={styles.rowMeta}>
                {row.creatorName} · {row.discount_percent}% off · {row.commission_percent}% commission · +{row.portal_coin_bonus} Portal Coins
              </Text>
              <Text style={styles.rowMeta}>
                {row.applicable_products === null ? 'All products' : `Only: ${row.applicable_products.map(productNameOf).join(', ')}`}
              </Text>
              <Text style={[styles.rowMeta, isExpired(row.expires_at) && styles.rowExpired]}>
                {row.expires_at ? `${isExpired(row.expires_at) ? 'Expired' : 'Expires'} ${formatDate(row.expires_at)}` : 'Never expires'}
              </Text>
              <Text style={styles.rowStats}>
                {row.redemptionCount} redemption{row.redemptionCount === 1 ? '' : 's'} · {formatBirr(row.totalDiscount)} discounted · {formatBirr(row.totalCommission)} commission
              </Text>
              <Button label="Edit" variant="outline" onPress={() => openEdit(row)} style={styles.editButton} />
            </View>
          ))}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  lead: { marginBottom: spacing.md, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  newButton: { marginBottom: spacing.md },
  loading: { marginTop: spacing.xl },
  empty: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },
  section: { marginTop: spacing.lg + 4, marginBottom: spacing.sm + 4, fontFamily: fonts.extrabold, fontSize: 18, color: colors.text, letterSpacing: -0.4 },
  form: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  formTitle: { fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  fieldLabel: { fontFamily: fonts.semibold, fontSize: 13.5, color: colors.textMuted },
  restrictRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textFaint },
  productList: { gap: 2 },
  productRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  productName: { flex: 1, marginRight: spacing.sm, fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  formButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  formButton: { flex: 1 },
  row: { marginBottom: spacing.sm + 2, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 4 },
  rowInactive: { opacity: 0.55 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowCode: { flex: 1, marginRight: spacing.sm, fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  rowMeta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  rowExpired: { color: colors.danger },
  rowStats: { fontFamily: fonts.semibold, fontSize: 12.5, color: colors.limeInk },
  editButton: { marginTop: spacing.xs },
});
