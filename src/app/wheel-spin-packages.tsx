import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  adminErrorMessage,
  createWheelSpinPackage,
  fetchWheelSpinPackages,
  setWheelSpinPackageActive,
  updateWheelSpinPackage,
  type WheelSpinPackageRow,
} from '../lib/admin';
import { useAuth } from '../lib/auth';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { useToast } from '../lib/toast';

import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { Toggle } from '../components/ui/Toggle';

type FormState = { spinsText: string; costText: string; sortText: string };
const EMPTY_FORM = (): FormState => ({ spinsText: '', costText: '', sortText: '0' });

function parsePositiveInt(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
function parseSortOrder(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) ? n : null;
}

/** Admin: create, edit and deactivate spin packages (what a customer can buy with Portal Coins). Same pattern as
 * the wheel-prizes and discount-codes admin screens. */
export default function WheelSpinPackagesScreen() {
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const allowed = !initializing && !!session && isAdmin;

  const packages = useAsync(fetchWheelSpinPackages, 0, allowed);

  const [editingId, setEditingId] = useState<string | null | 'new'>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  const spins = parsePositiveInt(form.spinsText);
  const cost = parsePositiveInt(form.costText);
  const sortOrder = parseSortOrder(form.sortText);
  const valid = spins !== null && cost !== null && sortOrder !== null;
  const spinsError = form.spinsText.length > 0 && spins === null ? 'A whole number, at least 1' : null;
  const costError = form.costText.length > 0 && cost === null ? 'A whole number, at least 1' : null;
  const sortError = form.sortText.length > 0 && sortOrder === null ? 'A whole number' : null;

  function openNew() {
    setForm(EMPTY_FORM());
    setError(null);
    setEditingId('new');
  }
  function openEdit(row: WheelSpinPackageRow) {
    setForm({ spinsText: String(row.spins_count), costText: String(row.portal_coin_cost), sortText: String(row.sort_order) });
    setError(null);
    setEditingId(row.id);
  }
  function closeForm() {
    setEditingId(null);
    setError(null);
  }

  async function save() {
    if (!valid || busy || spins === null || cost === null || sortOrder === null) return;
    setBusy(true);
    setError(null);
    try {
      const input = { spins_count: spins, portal_coin_cost: cost, sort_order: sortOrder };
      if (editingId === 'new') {
        await createWheelSpinPackage(input);
        toast('Package created');
      } else if (editingId) {
        await updateWheelSpinPackage(editingId, input);
        toast('Package saved');
      }
      closeForm();
      await packages.reload();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: WheelSpinPackageRow) {
    if (rowBusy) return;
    setRowBusy(row.id);
    try {
      await setWheelSpinPackageActive(row.id, !row.active);
      await packages.reload();
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
          <ScreenHeader title="Spin packages" onBack={() => (router.canGoBack() ? router.back() : router.replace('/me'))} />
          <Text style={styles.lead}>What a customer can buy with Portal Coins on the wheel screen. Lower sort order shows first.</Text>

          {editingId === null && <Button label="+ New package" onPress={openNew} style={styles.newButton} />}

          {editingId !== null && (
            <View style={styles.form}>
              <Text style={styles.formTitle}>{editingId === 'new' ? 'New package' : 'Edit package'}</Text>

              <TextField
                label="Spins"
                value={form.spinsText}
                onChangeText={(v) => setForm((c) => ({ ...c, spinsText: v }))}
                keyboardType="number-pad"
                placeholder="1"
                editable={!busy}
                error={spinsError}
              />
              <TextField
                label="Cost (Portal Coins)"
                value={form.costText}
                onChangeText={(v) => setForm((c) => ({ ...c, costText: v }))}
                keyboardType="number-pad"
                placeholder="10"
                editable={!busy}
                error={costError}
              />
              <TextField
                label="Sort order"
                value={form.sortText}
                onChangeText={(v) => setForm((c) => ({ ...c, sortText: v }))}
                keyboardType="number-pad"
                placeholder="0"
                editable={!busy}
                error={sortError}
              />

              {error && <ErrorBanner message={error} />}

              <View style={styles.formButtons}>
                <Button label="Cancel" variant="outline" onPress={closeForm} disabled={busy} style={styles.formButton} />
                <Button label="Save" onPress={save} loading={busy} disabled={!valid} style={styles.formButton} />
              </View>
            </View>
          )}

          <Text style={styles.section}>All packages</Text>
          {packages.status === 'loading' && !packages.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}
          {packages.status === 'error' && !packages.data && <ErrorBanner message="Couldn't load spin packages." />}
          {packages.data && packages.data.length === 0 && <Text style={styles.empty}>No spin packages yet.</Text>}

          {(packages.data ?? []).map((row) => (
            <View key={row.id} style={[styles.row, !row.active && styles.rowInactive]}>
              <View style={styles.rowHead}>
                <Text style={styles.rowLabel}>
                  {row.spins_count} spin{row.spins_count === 1 ? '' : 's'}
                </Text>
                <Toggle value={row.active} onValueChange={() => toggleActive(row)} label={`${row.spins_count} spins active`} disabled={rowBusy === row.id} />
              </View>
              <Text style={styles.rowMeta}>
                {row.portal_coin_cost} Portal Coins · sort {row.sort_order}
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
  formButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  formButton: { flex: 1 },
  row: { marginBottom: spacing.sm + 2, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 4 },
  rowInactive: { opacity: 0.55 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { flex: 1, marginRight: spacing.sm, fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  rowMeta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  editButton: { marginTop: spacing.xs },
});
