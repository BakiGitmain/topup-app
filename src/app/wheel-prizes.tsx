import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { adminErrorMessage, createWheelPrize, fetchWheelPrizes, setWheelPrizeActive, updateWheelPrize, type WheelPrizeRow } from '../lib/admin';
import { useAuth } from '../lib/auth';
import { formatBirr } from '../lib/catalog';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { useToast } from '../lib/toast';
import { oddsPercent } from '../lib/wheelLogic';

import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { Toggle } from '../components/ui/Toggle';

type FormState = { label: string; discountText: string; weightText: string };
const EMPTY_FORM = (): FormState => ({ label: '', discountText: '', weightText: '1' });

function parsePositiveNumber(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parsePositiveInt(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Admin: create, edit and deactivate wheel prizes (slices). Odds are shown next to each row, computed the same way
 * spin_wheel() itself picks a winner -- weight / sum of every ACTIVE prize's weight. Weight is customer-visible (see
 * the migration's flagged decision 1); only admins can write it.
 */
export default function WheelPrizesScreen() {
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const allowed = !initializing && !!session && isAdmin;

  const prizes = useAsync(fetchWheelPrizes, 0, allowed);

  const [editingId, setEditingId] = useState<string | null | 'new'>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  const discount = parsePositiveNumber(form.discountText);
  const weight = parsePositiveInt(form.weightText);
  const valid = form.label.trim().length > 0 && discount !== null && weight !== null;
  const discountError = form.discountText.length > 0 && discount === null ? 'Must be a number over 0' : null;
  const weightError = form.weightText.length > 0 && weight === null ? 'A whole number, at least 1' : null;

  const activeTotalWeight = (prizes.data ?? []).filter((p) => p.active).reduce((sum, p) => sum + p.weight, 0);

  function openNew() {
    setForm(EMPTY_FORM());
    setError(null);
    setEditingId('new');
  }
  function openEdit(row: WheelPrizeRow) {
    setForm({ label: row.label, discountText: String(row.discount_birr), weightText: String(row.weight) });
    setError(null);
    setEditingId(row.id);
  }
  function closeForm() {
    setEditingId(null);
    setError(null);
  }

  async function save() {
    if (!valid || busy || discount === null || weight === null) return;
    setBusy(true);
    setError(null);
    try {
      const input = { label: form.label.trim(), discount_birr: discount, weight };
      if (editingId === 'new') {
        await createWheelPrize(input);
        toast(`Prize ${input.label} created`);
      } else if (editingId) {
        await updateWheelPrize(editingId, input);
        toast(`Prize ${input.label} saved`);
      }
      closeForm();
      await prizes.reload();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: WheelPrizeRow) {
    if (rowBusy) return;
    setRowBusy(row.id);
    try {
      await setWheelPrizeActive(row.id, !row.active);
      await prizes.reload();
    } catch (err) {
      toast(adminErrorMessage(err));
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title="Wheel prizes" onBack={() => (router.canGoBack() ? router.back() : router.replace('/me'))} />
          <Text style={styles.lead}>
            Each prize is a slice on the customer wheel. Odds are weight ÷ the sum of every active prize&rsquo;s weight, and are shown to customers.
          </Text>

          {editingId === null && <Button label="+ New prize" onPress={openNew} style={styles.newButton} />}

          {editingId !== null && (
            <View style={styles.form}>
              <Text style={styles.formTitle}>{editingId === 'new' ? 'New prize' : `Edit ${form.label}`}</Text>

              <TextField label="Label" value={form.label} onChangeText={(v) => setForm((c) => ({ ...c, label: v }))} maxLength={40} editable={!busy} />
              <TextField
                label="Discount (birr)"
                value={form.discountText}
                onChangeText={(v) => setForm((c) => ({ ...c, discountText: v }))}
                keyboardType="decimal-pad"
                placeholder="100"
                editable={!busy}
                error={discountError}
              />
              <TextField
                label="Weight (relative odds -- higher wins more often)"
                value={form.weightText}
                onChangeText={(v) => setForm((c) => ({ ...c, weightText: v }))}
                keyboardType="number-pad"
                placeholder="1"
                editable={!busy}
                error={weightError}
              />

              {error && <ErrorBanner message={error} />}

              <View style={styles.formButtons}>
                <Button label="Cancel" variant="outline" onPress={closeForm} disabled={busy} style={styles.formButton} />
                <Button label="Save" onPress={save} loading={busy} disabled={!valid} style={styles.formButton} />
              </View>
            </View>
          )}

          <Text style={styles.section}>All prizes</Text>
          {prizes.status === 'loading' && !prizes.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}
          {prizes.status === 'error' && !prizes.data && <ErrorBanner message="Couldn't load wheel prizes." />}
          {prizes.data && prizes.data.length === 0 && <Text style={styles.empty}>No wheel prizes yet.</Text>}

          {(prizes.data ?? []).map((row) => {
            const odds = row.active ? oddsPercent(row.weight, activeTotalWeight) : null;
            return (
              <View key={row.id} style={[styles.row, !row.active && styles.rowInactive]}>
                <View style={styles.rowHead}>
                  <Text style={styles.rowLabel} numberOfLines={1}>
                    {row.label}
                  </Text>
                  <Toggle value={row.active} onValueChange={() => toggleActive(row)} label={`${row.label} active`} disabled={rowBusy === row.id} />
                </View>
                <Text style={styles.rowMeta}>
                  {formatBirr(row.discount_birr)} off · weight {row.weight}
                  {odds !== null ? ` · ${odds}% odds` : ''}
                </Text>
                <Button label="Edit" variant="outline" onPress={() => openEdit(row)} style={styles.editButton} />
              </View>
            );
          })}
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
  formButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  formButton: { flex: 1 },
  row: { marginBottom: spacing.sm + 2, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 4 },
  rowInactive: { opacity: 0.55 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { flex: 1, marginRight: spacing.sm, fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  rowMeta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  editButton: { marginTop: spacing.xs },
});
