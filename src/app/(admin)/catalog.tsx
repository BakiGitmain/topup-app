import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon } from '../../components/art/Icons';
import { ProductGlyph } from '../../components/art/ProductGlyph';
import { StateMessage } from '../../components/market/StateMessage';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { Toggle } from '../../components/ui/Toggle';
import { adminErrorMessage, applyActiveChanges, deleteProduct, fetchAdminProducts, type AdminProduct } from '../../lib/admin';
import { removeArtworkPaths } from '../../lib/artwork';
import { pathFromPublicUrl } from '../../lib/artworkSize';
import { safeImageUrl } from '../../lib/catalogRules';
import { IconButton } from '../../components/ui/IconButton';
import { confirmDestructive } from '../../lib/confirm';
import {
  countChanges,
  describeFailures,
  emptyState,
  parseBatchFailures,
  pendingChanges,
  prune,
  setLocal as setSwitch,
  valueOf,
  type ActiveState,
} from '../../lib/manageCatalog';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';

export default function CatalogScreen() {
  const products = useAsync(fetchAdminProducts);
  useRefreshOnFocus(products.reload);
  const toast = useToast();

  const [refreshing, setRefreshing] = useState(false);
  // What the admin has tapped but not saved. Tapping a switch changes only this, never the database.
  const [tapped, setTapped] = useState<ActiveState>(emptyState());
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = useMemo(() => products.data ?? [], [products.data]);
  const saved = useMemo<ActiveState>(() => ({ products: Object.fromEntries(all.map((p) => [p.id, p.is_active])), regions: {}, options: {} }), [all]);
  // Only taps that still differ from what is saved count (a reload or a save makes the rest disappear).
  const local = useMemo(() => prune(saved, tapped), [saved, tapped]);

  const changes = pendingChanges(saved, local);
  const pending = countChanges(changes);
  const loading = products.status === 'loading' && !products.data;

  async function onRefresh() {
    setRefreshing(true);
    await products.reload();
    setRefreshing(false);
  }

  async function save() {
    if (pending === 0 || saving) return;
    setSaving(true);
    setProblems([]);
    setError(null);
    try {
      const done = await applyActiveChanges(changes);
      toast(`Saved ${done} change${done === 1 ? '' : 's'}`);
      await products.reload();
    } catch (err) {
      // All or nothing: the request was rolled back, so say exactly which items were refused.
      const failures = parseBatchFailures(err);
      if (failures !== null && failures.length > 0) {
        setProblems(describeFailures(failures, Object.fromEntries(all.map((p) => [p.id, p.name]))));
      } else {
        setError(`Nothing was saved. ${adminErrorMessage(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(product: AdminProduct) {
    const ok = await confirmDestructive(
      `Remove ${product.name}?`,
      'This deletes the product with its packs, regions and images. It cannot be undone. If it has ever been ordered, it will be refused and you should switch it off instead.',
      'Remove'
    );
    if (!ok) return;
    setRemoving(product.id);
    setError(null);
    try {
      const result = await deleteProduct(product.id);
      const hero = pathFromPublicUrl(result.image_url);
      await removeArtworkPaths([...result.image_paths, ...(hero ? [hero] : [])]);
      toast(`${product.name} removed`);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setRemoving(null);
      products.reload();
    }
  }

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh}>
      <Column>
        <Text style={styles.title}>Catalog</Text>

        <Pressable
          onPress={() => router.push('/import-product')}
          accessibilityRole="button"
          accessibilityLabel="Import from supplier"
          style={({ pressed }) => [styles.importRow, pressed && styles.pressed]}
        >
          <FeatherIcon name="package" size={20} color={colors.limeInk} />
          <Text style={styles.importText}>Import from supplier</Text>
          <FeatherIcon name="chevron-right" size={20} color={colors.textMuted} />
        </Pressable>

        {pending > 0 && (
          <View style={styles.unsaved} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <View style={styles.unsavedText}>
              <Text style={styles.unsavedTitle}>
                {pending} unsaved change{pending === 1 ? '' : 's'}
              </Text>
              <Text style={styles.unsavedBody}>Nothing changes for customers until you save.</Text>
            </View>
            <Button label="Save" icon="check" onPress={save} loading={saving} style={styles.saveButton} />
          </View>
        )}

        {problems.length > 0 && <ErrorBanner message={`Nothing was saved, because:\n${problems.join('\n')}`} />}
        {error && <ErrorBanner message={error} />}

        {loading && <ListSkeleton />}

        {products.status === 'error' && !products.data && (
          <StateMessage
            tone="danger"
            icon={<AlertIcon size={30} color={colors.danger} />}
            title="Couldn't load the catalog"
            body="Check your connection, then try again."
            actionLabel="Try again"
            onAction={products.reload}
          />
        )}

        {products.data && all.length === 0 && (
          <StateMessage
            icon={<FeatherIcon name="package" size={30} color={colors.limeInk} />}
            title="No products yet"
            body="Import your first product from the supplier."
            actionLabel="Import from supplier"
            onAction={() => router.push('/import-product')}
          />
        )}

        <View style={styles.list}>
          {all.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              on={valueOf(saved, local, 'products', product.id)}
              changed={product.id in local.products}
              busy={removing === product.id || saving}
              onToggle={(next) => setTapped((current) => setSwitch(saved, prune(saved, current), 'products', product.id, next))}
              onEdit={() => router.push({ pathname: '/edit-product/[id]', params: { id: product.id } })}
              onRemove={() => remove(product)}
            />
          ))}
        </View>
      </Column>
    </TabScroll>
  );
}

function ProductRow({
  product,
  on,
  changed,
  busy,
  onToggle,
  onEdit,
  onRemove,
}: {
  product: AdminProduct;
  on: boolean;
  changed: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = safeImageUrl(product.image_url);
  const showImage = url !== null && failedUrl !== url;

  return (
    <View style={[styles.row, changed && styles.rowChanged]}>
      <View style={styles.top}>
        <View style={[styles.thumb, { backgroundColor: showImage ? colors.surface : product.tint }]}>
          {showImage ? (
            <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="cover" onError={() => setFailedUrl(url)} accessibilityIgnoresInvertColors />
          ) : (
            <ProductGlyph kind={product.glyph} size={26} />
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={2}>
            {product.name}
          </Text>
          <Text style={[styles.state, on && styles.stateOn]}>
            {on ? 'On sale' : 'Hidden'}
            {changed ? '  ·  unsaved' : ''}
          </Text>
        </View>
        <Toggle value={on} onValueChange={onToggle} label={`${product.name} visible in shop`} />
      </View>

      <View style={styles.actions}>
        <IconButton icon="edit-2" label={`Edit ${product.name}`} onPress={onEdit} disabled={busy} size={40} />
        <IconButton icon="trash-2" label={`Remove ${product.name}`} onPress={onRemove} disabled={busy} tone="danger" size={40} />
      </View>
    </View>
  );
}

function ListSkeleton() {
  return (
    <View style={styles.list} accessibilityRole="progressbar" accessibilityLabel="Loading products">
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.row, styles.skeleton]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.extrabold, fontSize: 32, color: colors.text, letterSpacing: -1, paddingTop: spacing.md, marginBottom: spacing.md },
  importRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    minHeight: 52,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.limeSoft,
  },
  importText: { flex: 1, fontFamily: fonts.bold, fontSize: 14.5, color: colors.limeDark },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
  unsaved: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: '#FFF1CC',
    borderWidth: 1,
    borderColor: '#EBCB7A',
  },
  unsavedText: { flex: 1 },
  unsavedTitle: { fontFamily: fonts.bold, fontSize: 15, color: '#6B4700' },
  unsavedBody: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: '#6B4700' },
  saveButton: { width: 104 },
  list: { gap: spacing.sm + 2 },
  row: {
    padding: spacing.md - 2,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowChanged: { borderColor: '#EBCB7A', backgroundColor: '#FFFBEF' },
  skeleton: { height: 110, backgroundColor: colors.border, opacity: 0.6 },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.md - 2 },
  thumb: { width: 52, height: 52, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  state: { marginTop: 2, fontFamily: fonts.semibold, fontSize: 12.5, color: colors.textMuted },
  stateOn: { color: colors.limeDark },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  action: { minHeight: 44, minWidth: 72, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  editText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.limeInk },
  removeText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.danger },
});
