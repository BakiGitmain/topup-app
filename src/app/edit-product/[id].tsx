import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ArtworkPicker } from '../../components/admin/ArtworkPicker';
import { CategoriesEditor } from '../../components/admin/CategoriesEditor';
import { ImageGallery } from '../../components/admin/ImageGallery';
import { PackEditor, draftOf, type PackDraft } from '../../components/admin/PackEditor';
import { AlertIcon } from '../../components/art/Icons';
import { StateMessage } from '../../components/market/StateMessage';
import { PackageGrid } from '../../components/product/PackageGrid';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { TextField } from '../../components/ui/TextField';
import { Toggle } from '../../components/ui/Toggle';
import {
  addCategory,
  addOption,
  addProductImage,
  adminErrorMessage,
  applyActiveChanges,
  deleteCategory,
  fetchAdminProduct,
  removeProductImage,
  renameCategory,
  updateProduct,
  type AdminOption,
  type AdminProduct,
  type AdminRegion,
} from '../../lib/admin';
import { hiddenReasonText, productStatus, sectionsForEditor } from '../../lib/adminCatalog';
import { pickArtwork, prepareArtwork, removeArtwork, removeArtworkPaths, uploadArtwork } from '../../lib/artwork';
import { CARD_IMAGE_MAX_SIDE, pathFromPublicUrl } from '../../lib/artworkSize';
import { useAuth } from '../../lib/auth';
import { safeImageUrl } from '../../lib/catalogRules';
import { confirmDestructive } from '../../lib/confirm';
import { MAX_CATEGORIES, MAX_GALLERY_IMAGES } from '../../lib/importPlan';
import {
  countChanges,
  describeFailures,
  emptyState,
  parseBatchFailures,
  pendingChanges,
  prune,
  setLocal as setSwitch,
  valueOf,
  type ActiveKind,
  type ActiveState,
} from '../../lib/manageCatalog';
import { checkPrices, priceCheckMessage } from '../../lib/pricing';
import { groupPackages, type PackageView } from '../../lib/productView';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { fetchUsdRate } from '../../lib/supplierCatalog';
import { useAsync } from '../../lib/useAsync';

/** The saved on/off value of every switch on this product. */
function activeStateOf(product: AdminProduct | null): ActiveState {
  if (!product) return emptyState();
  return {
    products: { [product.id]: product.is_active },
    regions: Object.fromEntries(product.regions.map((r) => [r.id, r.is_active])),
    options: Object.fromEntries(product.options.map((o) => [o.id, o.is_active])),
  };
}

export default function EditProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  // Convenience only: the database enforces who may write. Not before sign-in has finished.
  const allowed = !initializing && !!session && isAdmin && !!id;
  const product = useAsync(() => fetchAdminProduct(id), id ?? '', allowed);
  // The shared exchange rate, for each pack's markup stepper. If it can't be read the steppers are simply not shown.
  const usdRate = useAsync(fetchUsdRate, 0, allowed);

  const [drafts, setDrafts] = useState<Record<string, PackDraft>>({});
  const [refreshing, setRefreshing] = useState(false);

  // The on/off switches: tapping only changes `local`; Save sends every change in one request.
  const data = product.data;
  const saved = useMemo(() => activeStateOf(data), [data]);
  const [tapped, setTapped] = useState<ActiveState>(emptyState());
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Only taps that still differ from what is saved count (a reload or a save makes the rest disappear).
  const local = useMemo(() => prune(saved, tapped), [saved, tapped]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;
  if (!id) return <Redirect href="/catalog" />;

  const changes = pendingChanges(saved, local);
  const pending = countChanges(changes);
  const on = (kind: ActiveKind, itemId: string) => valueOf(saved, local, kind, itemId);
  const flip = (kind: ActiveKind, itemId: string, next: boolean) => setTapped((current) => setSwitch(saved, prune(saved, current), kind, itemId, next));

  // What the product will look like once the unsaved switches are saved (drives the status and the preview).
  const effective: AdminProduct | null = data
    ? {
        ...data,
        is_active: on('products', data.id),
        regions: data.regions.map((r) => ({ ...r, is_active: on('regions', r.id) })),
        options: data.options.map((o) => ({ ...o, is_active: on('options', o.id) })),
      }
    : null;

  const setDraft = (packId: string, draft: PackDraft | null) =>
    setDrafts((current) => {
      const next = { ...current };
      if (draft === null) delete next[packId];
      else next[packId] = draft;
      return next;
    });

  async function onRefresh() {
    setRefreshing(true);
    await product.reload();
    setRefreshing(false);
  }

  async function saveSwitches() {
    if (!data || pending === 0 || saving) return;
    setSaving(true);
    setProblems([]);
    setSaveError(null);
    try {
      const done = await applyActiveChanges(changes);
      toast(`Saved ${done} change${done === 1 ? '' : 's'}`);
      await product.reload();
    } catch (err) {
      // All or nothing: the request was rolled back, so say exactly which items were refused.
      const failures = parseBatchFailures(err);
      if (failures !== null && failures.length > 0) {
        const names: Record<string, string> = { [data.id]: data.name };
        for (const r of data.regions) names[r.id] = r.label;
        for (const o of data.options) names[o.id] = o.label;
        setProblems(describeFailures(failures, names));
      } else {
        setSaveError(`Nothing was saved. ${adminErrorMessage(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.limeDeep} colors={[colors.limeDeep]} />}
      >
        <Column>
          <ScreenHeader title={data?.name ?? ''} />

          {product.status === 'loading' && !data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {product.status === 'error' && !data && (
            <StateMessage
              tone="danger"
              icon={<AlertIcon size={30} color={colors.danger} />}
              title="Couldn't load this product"
              body="Check your connection, then try again."
              actionLabel="Try again"
              onAction={product.reload}
            />
          )}

          {product.status === 'ready' && !data && (
            <StateMessage
              icon={<AlertIcon size={30} color={colors.limeInk} />}
              title="This product no longer exists"
              body="It may have been removed."
              actionLabel="Back to catalog"
              onAction={() => router.replace('/catalog')}
            />
          )}

          {data && effective && (
            <>
              {pending > 0 && (
                <View style={styles.unsaved} accessibilityRole="alert" accessibilityLiveRegion="polite">
                  <View style={styles.flex}>
                    <Text style={styles.unsavedTitle}>
                      {pending} unsaved on/off change{pending === 1 ? '' : 's'}
                    </Text>
                    <Text style={styles.unsavedBody}>Nothing changes for customers until you save.</Text>
                  </View>
                  <Button label="Save" onPress={saveSwitches} loading={saving} style={styles.saveButton} />
                </View>
              )}
              {problems.length > 0 && <ErrorBanner message={`Nothing was saved, because:\n${problems.join('\n')}`} />}
              {saveError && <ErrorBanner message={saveError} />}

              <StatusCard product={effective} changed={data.id in local.products} onToggle={(next) => flip('products', data.id, next)} />
              <DetailsCard key={`${data.id}:${data.name}:${data.tagline}:${data.description ?? ''}`} product={data} onChanged={product.reload} />

              <Text style={styles.section}>Banner image</Text>
              <BannerCard product={data} onChanged={product.reload} />

              <Text style={styles.section}>Images for pack cards</Text>
              <Text style={styles.hint}>Upload the pictures once here, then choose one for each pack below. Each is cropped square and shrunk to {CARD_IMAGE_MAX_SIDE}px.</Text>
              <ImagesCard product={data} onChanged={product.reload} />

              <Text style={styles.section}>Categories</Text>
              <CategoriesCard product={data} onChanged={product.reload} />

              <RegionsCard regions={effective.regions} changedIds={new Set(Object.keys(local.regions))} onToggle={(regionId, next) => flip('regions', regionId, next)} />

              <Text style={styles.section}>Packs and prices</Text>
              <Text style={styles.hint}>
                Price changes apply to new orders only. Orders already placed keep the price they were bought at.
              </Text>
              {sectionsForEditor(data.options, data.regions).map((section) => (
                <View key={section.region?.id ?? 'no-region'} style={styles.regionBlock}>
                  {(data.regions.length > 0 || section.region) && (
                    <Text style={styles.regionTitle} accessibilityRole="header">
                      {section.region ? section.region.label : 'No region'}
                    </Text>
                  )}
                  {section.groups.map((group) => (
                    <View key={group.label ?? 'ungrouped'}>
                      {group.label !== null && <Text style={styles.groupTitle}>{group.label}</Text>}
                      {group.packs.map((pack) => (
                        <PackEditor
                          key={pack.id}
                          pack={pack}
                          draft={drafts[pack.id] ?? draftOf(pack)}
                          onDraft={(d) => setDraft(pack.id, d)}
                          onChanged={product.reload}
                          active={on('options', pack.id)}
                          activeChanged={pack.id in local.options}
                          onActive={(next) => flip('options', pack.id, next)}
                          gallery={data.images}
                          categories={data.categories}
                          rate={usdRate.data}
                        />
                      ))}
                    </View>
                  ))}
                </View>
              ))}

              {data.regions.length === 0 && <AddPack product={data} onChanged={product.reload} />}

              <Preview product={effective} drafts={drafts} />
            </>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

/** On sale or hidden, and why; plus the master switch. Tapping it changes nothing until Save. */
function StatusCard({ product, changed, onToggle }: { product: AdminProduct; changed: boolean; onToggle: (next: boolean) => void }) {
  const status = productStatus(product);

  return (
    <View style={styles.card}>
      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <View style={styles.statusLine}>
            <View style={[styles.pill, status.status === 'on_sale' ? styles.pillOn : styles.pillOff]}>
              <Text style={[styles.pillText, status.status === 'on_sale' ? styles.pillTextOn : styles.pillTextOff]} accessibilityLabel={`Status: ${status.status === 'on_sale' ? 'on sale' : 'hidden'}`}>
                {status.status === 'on_sale' ? 'On sale' : 'Hidden'}
                {changed ? '  ·  unsaved' : ''}
              </Text>
            </View>
          </View>
          <Text style={styles.strong}>Visible in the shop</Text>
          <Text style={styles.hint}>
            {status.status === 'hidden' ? hiddenReasonText(status.reason) : 'Customers can see and buy it.'}
          </Text>
        </View>
        <Toggle value={product.is_active} onValueChange={onToggle} label={`${product.name} visible in shop`} />
      </View>
    </View>
  );
}

function DetailsCard({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const [name, setName] = useState(product.name);
  const [tagline, setTagline] = useState(product.tagline);
  const [description, setDescription] = useState(product.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const dirty =
    name.trim() !== product.name || tagline.trim() !== product.tagline || description.trim() !== (product.description ?? '');

  async function save() {
    if (!name.trim()) return setError('Give the product a name.');
    setError(null);
    setBusy(true);
    try {
      await updateProduct(product.id, { name: name.trim(), tagline: tagline.trim(), description: description.trim() || null });
      toast('Saved');
      onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <TextField label="Name" value={name} onChangeText={setName} editable={!busy} />
      <TextField label="Short description" value={tagline} onChangeText={setTagline} editable={!busy} />
      <TextField
        label="Description (shown on the product page)"
        value={description}
        onChangeText={setDescription}
        editable={!busy}
        multiline
        boxStyle={styles.multiBox}
        style={styles.multiInput}
        placeholder="Leave empty to show nothing"
      />
      {error ? <ErrorBanner message={error} /> : null}
      {dirty ? <Button label="Save details" onPress={save} loading={busy} /> : null}
    </View>
  );
}

/** The wide picture at the top of the product page. Replacing it uploads the new file, then removes the old one. */
function BannerCard({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = safeImageUrl(product.image_url);

  async function replace() {
    setError(null);
    let picked;
    try {
      picked = await pickArtwork();
    } catch {
      return setError("Couldn't open your photos.");
    }
    if (!picked) return;

    setBusy(true);
    try {
      let uploaded;
      try {
        uploaded = await uploadArtwork(await prepareArtwork(picked));
      } catch {
        return setError("Couldn't upload the image. Try another one.");
      }
      try {
        await updateProduct(product.id, { image_url: uploaded.url });
      } catch (err) {
        await removeArtwork(uploaded.path);
        return setError(adminErrorMessage(err));
      }
      const old = pathFromPublicUrl(product.image_url);
      if (old) await removeArtworkPaths([old]);
      toast('Banner image saved');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setError(null);
    setBusy(true);
    try {
      await updateProduct(product.id, { image_url: null });
      const old = pathFromPublicUrl(product.image_url);
      if (old) await removeArtworkPaths([old]);
      toast('Banner image removed');
      onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <ArtworkPicker picked={current ? { uri: current, width: 0, height: 0 } : null} onPick={replace} onRemove={clear} disabled={busy} error={error} />
    </View>
  );
}

/** The product's uploaded card images. Add saves at once; removing frees the packs that used the image. */
function ImagesCard({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    let picked;
    try {
      picked = await pickArtwork();
    } catch {
      return setError("Couldn't open your photos.");
    }
    if (!picked) return;

    setBusy(true);
    try {
      let uploaded;
      try {
        uploaded = await uploadArtwork(await prepareArtwork(picked, CARD_IMAGE_MAX_SIDE));
      } catch {
        return setError("Couldn't upload the image. Try another one.");
      }
      try {
        await addProductImage(product.id, uploaded.path);
      } catch (err) {
        await removeArtwork(uploaded.path);
        return setError(adminErrorMessage(err));
      }
      toast('Image added');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(imageId: string) {
    const image = product.images.find((i) => i.id === imageId);
    if (!image) return;
    const using = product.options.filter((o) => o.image_url === image.url).length;
    const ok = await confirmDestructive(
      'Remove this image?',
      using > 0
        ? `${using} pack${using === 1 ? ' uses' : 's use'} it. ${using === 1 ? 'It' : 'They'} will go back to the text-only card.`
        : 'No pack uses it.',
      'Remove'
    );
    if (!ok) return;
    setError(null);
    setBusy(true);
    try {
      await removeProductImage(image.id);
      await removeArtwork(image.path);
      toast('Image removed');
      onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <ImageGallery
        items={product.images.map((i) => ({ key: i.id, uri: i.url }))}
        onAdd={add}
        onRemove={remove}
        busy={busy}
        max={MAX_GALLERY_IMAGES}
        error={error}
        emptyText="No images yet. Without one, a pack shows as a plain text card."
      />
    </View>
  );
}

/** Add, rename and remove. A category with packs still in it cannot be removed: move them first. */
function CategoriesCard({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, done: string): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      await action();
      toast(done);
      onChanged();
      return true;
    } catch (err) {
      setError(adminErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const nextSort = product.categories.reduce((max, c) => Math.max(max, c.sort_order), 0) + 1;

  return (
    <View style={styles.card}>
      <CategoriesEditor
        items={product.categories}
        max={MAX_CATEGORIES}
        busy={busy}
        error={error}
        onAdd={(label) => run(() => addCategory(product.id, label, nextSort), 'Category added')}
        onRename={(categoryId, label) => run(() => renameCategory(categoryId, label), 'Category renamed')}
        onRemove={(categoryId) => run(() => deleteCategory(categoryId), 'Category removed')}
      />
    </View>
  );
}

function RegionsCard({
  regions,
  changedIds,
  onToggle,
}: {
  regions: AdminRegion[];
  changedIds: ReadonlySet<string>;
  onToggle: (regionId: string, next: boolean) => void;
}) {
  if (regions.length === 0) return null;

  return (
    <View>
      <Text style={styles.section}>Regions</Text>
      <View style={styles.card}>
        {regions.map((region, i) => (
          <View key={region.id} style={[styles.switchRow, i > 0 && styles.divider]}>
            <View style={styles.flex}>
              <Text style={styles.strong}>
                {region.label}
                {changedIds.has(region.id) ? '  ·  unsaved' : ''}
              </Text>
              <Text style={styles.hint}>
                {region.id_validation === 'supplier' ? 'Player ID is checked with the game' : 'Customer ticks "I\'ve checked my ID"'}
                {' · '}
                {region.field_count} field{region.field_count === 1 ? '' : 's'}
              </Text>
            </View>
            <Toggle value={region.is_active} onValueChange={(next) => onToggle(region.id, next)} label={`${region.label} region on`} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** For older products with no regions: add one more pack by hand. */
function AddPack({ product, onChanged }: { product: AdminProduct; onChanged: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = checkPrices(price, '');
  const nextSort = product.options.reduce((max, o) => Math.max(max, o.sort_order), 0) + 1;

  async function add() {
    if (!label.trim()) return setError('Give the pack a name.');
    if (!check.ok) return setError(priceCheckMessage(check));
    setError(null);
    setBusy(true);
    try {
      await addOption(product.id, label.trim(), check.price, nextSort);
      setLabel('');
      setPrice('');
      toast('Pack added');
      onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.strong}>Add a pack</Text>
      <View style={styles.row}>
        <View style={styles.flex}>
          <TextField label="Pack" value={label} onChangeText={setLabel} placeholder="e.g. 520 Diamonds" editable={!busy} />
        </View>
        <View style={styles.priceCol}>
          <TextField label="Price (Br)" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0" editable={!busy} />
        </View>
      </View>
      {error ? <ErrorBanner message={error} /> : null}
      <Button label="Add pack" variant="outline" onPress={add} loading={busy} />
    </View>
  );
}

/** The real customer cards, fed with what is typed here (unsaved) so the admin sees the result before saving. */
function Preview({ product, drafts }: { product: AdminProduct; drafts: Record<string, PackDraft> }) {
  const views = (options: AdminOption[]): PackageView[] =>
    options.map((pack) => {
      const draft = drafts[pack.id];
      const check = draft ? checkPrices(draft.price, draft.oldPrice) : null;
      return {
        id: pack.id,
        label: draft?.label.trim() || pack.label,
        groupLabel: pack.group_label,
        price: check?.ok ? check.price : pack.price,
        oldPrice: check?.ok ? check.oldPrice : pack.old_price,
        regionId: pack.region_id,
        regionLocked: pack.region_locked,
        accountRegionCodes: pack.account_region_codes,
        sortOrder: pack.sort_order,
        imageUrl: safeImageUrl(draft ? draft.imageUrl : pack.image_url),
        categoryId: draft ? draft.categoryId : pack.category_id,
      };
    });
  const active = new Set(product.options.filter((o) => o.is_active).map((o) => o.id));

  return (
    <View testID="preview">
      <Text style={styles.section}>Preview: what customers see</Text>
      <Text style={styles.hint}>Packs that are switched off show as unavailable here and are hidden from customers. Category pills are not drawn here.</Text>
      {sectionsForEditor(product.options, product.regions).map((section) => (
        <View key={section.region?.id ?? 'no-region'} style={styles.previewBlock}>
          {product.regions.length > 1 && section.region && <Text style={styles.groupTitle}>{section.region.label}</Text>}
          <PackageGrid
            groups={groupPackages(views(section.groups.flatMap((g) => g.packs)))}
            selectedId={null}
            onSelect={() => {}}
            stateOf={(p) => (active.has(p.id) ? 'ok' : 'unavailable')}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  loading: { marginTop: spacing.xxl },
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
  unsavedTitle: { fontFamily: fonts.bold, fontSize: 15, color: '#6B4700' },
  unsavedBody: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: '#6B4700' },
  saveButton: { width: 104 },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: spacing.sm, paddingTop: spacing.sm + 2 },
  statusLine: { flexDirection: 'row', marginBottom: 6 },
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  pillOn: { backgroundColor: colors.limeSoft },
  pillOff: { backgroundColor: colors.borderStrong },
  pillText: { fontFamily: fonts.bold, fontSize: 12 },
  pillTextOn: { color: colors.limeDark },
  pillTextOff: { color: colors.text },
  strong: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  hint: { marginTop: 2, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted, marginBottom: spacing.xs },
  section: { fontFamily: fonts.extrabold, fontSize: 19, color: colors.text, letterSpacing: -0.4, marginTop: spacing.md, marginBottom: spacing.xs },
  regionBlock: { marginTop: spacing.sm },
  regionTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.limeInk, marginBottom: spacing.xs },
  groupTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.textMuted, marginVertical: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm + 4 },
  priceCol: { width: 120 },
  multiBox: { height: 110, alignItems: 'flex-start', paddingVertical: 10 },
  multiInput: { textAlignVertical: 'top', height: '100%' },
  previewBlock: { marginBottom: spacing.sm },
});
