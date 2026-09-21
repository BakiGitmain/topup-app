import { Redirect, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ArtworkPicker } from '../components/admin/ArtworkPicker';
import { CategoriesEditor } from '../components/admin/CategoriesEditor';
import { ImageGallery } from '../components/admin/ImageGallery';
import { FreshnessPill } from '../components/admin/FreshnessPill';
import { ImportRegionPacks } from '../components/admin/ImportRegionPacks';
import { FeatherIcon } from '../components/art/FeatherIcon';
import { SearchBar } from '../components/market/SearchBar';
import { Button } from '../components/ui/Button';
import { ExchangeRateField } from '../components/admin/ExchangeRateField';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { PillGroup } from '../components/ui/PillGroup';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { adminErrorMessage } from '../lib/admin';
import { parseRegionCodes } from '../lib/adminCatalog';
import { pickArtwork, prepareArtwork, removeArtworkPaths, uploadArtwork, type PickedArtwork } from '../lib/artwork';
import { CARD_IMAGE_MAX_SIDE } from '../lib/artworkSize';
import { useAuth } from '../lib/auth';
import { parsePrice } from '../lib/format';
import {
  applyOutcome,
  MAX_CATEGORIES,
  MAX_GALLERY_IMAGES,
  buildImportPayload,
  categoryKeyFor,
  costRange,
  effectiveRow,
  formatUsdRange,
  groupByGame,
  initialRegionState,
  oldestDate,
  stalePriceWarnings,
  staleLevel,
  unreachableText,
  SUPPLIERS,
  SUPPLIER_LABEL,
  type CatalogRow,
  type GameGroup,
  type ImportCategory,
  type RegionChoice,
  type RegionState,
  type SupplierName,
} from '../lib/importPlan';
import { parseRate, recalcDrafts } from '../lib/priceCalc';
import {
  SEARCH_LIMIT,
  fetchCatalogStatus,
  fetchUsdRate,
  importProduct,
  loadOffers,
  refreshCatalog,
  saveUsdRate,
  searchCatalog,
} from '../lib/supplierCatalog';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useToast } from '../lib/toast';
import { SEARCH_IDLE_MS } from '../lib/searchLogic';
import { useAsync } from '../lib/useAsync';
import { useDebouncedSearch } from '../lib/useDebounced';

const FAMILY_LABEL = { topups: 'Game top-up', giftcards: 'Gift card' } as const;

export default function ImportProductScreen() {
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const allowed = !initializing && !!session && isAdmin;

  // Which supplier's saved catalog is searched and refreshed. Each import is from ONE supplier.
  const [supplier, setSupplier] = useState<SupplierName>('fazercards');
  const status = useAsync(() => fetchCatalogStatus(supplier), supplier, allowed);
  const [query, setQuery] = useState('');
  // One request per pause in typing (1.5 s), and none for fewer than two letters. Enter searches at once.
  const search = useDebouncedSearch(query.trim(), SEARCH_IDLE_MS);
  const debounced = search.value;
  const results = useAsync(() => searchCatalog(debounced, supplier), `${supplier}|${debounced}`, allowed && debounced.length >= 2);
  const groups = useMemo(() => groupByGame(results.data ?? []), [results.data]);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<{ text: string; ok: boolean } | null>(null);

  const [game, setGame] = useState<GameGroup | null>(null);
  const [name, setName] = useState('');
  const [regions, setRegions] = useState<Record<string, RegionState>>({});
  const [art, setArt] = useState<PickedArtwork | null>(null);
  const [artError, setArtError] = useState<string | null>(null);
  // Card images picked for this product (uploaded when you save), and its categories.
  const [gallery, setGallery] = useState<{ key: string; picked: PickedArtwork }[]>([]);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [cats, setCats] = useState<ImportCategory[]>([]);
  const [catError, setCatError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The price calculator. The saved rate is read once; what is typed in the box is used at once (saving it is a separate button).
  const rate = useAsync(fetchUsdRate, 0, allowed);
  const [rateEdit, setRateEdit] = useState<string | null>(null);
  const [savingRate, setSavingRate] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  // ---------------------------------------------------------------- the price calculator

  const rateText = rateEdit ?? (rate.data !== null ? String(rate.data) : '');
  const rateValue = parseRate(rateText);

  /** The shared rate changed: every picked pack is recalculated at ITS OWN markup. A price the admin typed is kept. */
  function applyRate(next: number) {
    let changed = 0;
    let kept = 0;
    const updated: Record<string, RegionState> = {};
    for (const [id, state] of Object.entries(regions)) {
      const out = recalcDrafts(state.packs, state.data?.offers ?? [], next);
      changed += out.changed;
      kept += out.kept;
      updated[id] = out.drafts === state.packs ? state : { ...state, packs: out.drafts };
    }
    setRegions(updated);
    setPriceNote(
      changed === 0 && kept === 0
        ? null
        : `Updated ${changed} price${changed === 1 ? '' : 's'}.${kept > 0 ? ` ${kept} you typed ${kept === 1 ? 'was' : 'were'} kept.` : ''}`
    );
  }

  function changeRate(text: string) {
    setRateEdit(text);
    setRateError(null);
    const value = parseRate(text);
    if (value !== null) applyRate(value);
  }

  async function onSaveRate() {
    if (rateValue === null || savingRate) return;
    setSavingRate(true);
    setRateError(null);
    try {
      await saveUsdRate(rateValue);
      await rate.reload();
      setRateEdit(null);
      toast('Exchange rate saved.');
    } catch {
      setRateError("Couldn't save the rate. Only admins can change it; check your connection and try again.");
    } finally {
      setSavingRate(false);
    }
  }

  // ---------------------------------------------------------------- catalog refresh

  async function onRefreshCatalog() {
    setRefreshing(true);
    setRefreshNote(null);
    const out = await refreshCatalog(supplier);
    if (out.kind === 'ok') {
      setRefreshNote({ ok: true, text: `Catalog refreshed: ${out.categories} categories${out.removed > 0 ? `, ${out.removed} no longer listed were removed` : ''}.` });
    } else if (out.kind === 'unavailable') {
      setRefreshNote({ ok: false, text: `${unreachableText(out.reason)} Nothing changed, and search still works from the saved catalog.` });
    } else if (out.kind === 'suspicious') {
      setRefreshNote({ ok: false, text: `The supplier returned only ${out.found} categories (${out.saved} are saved), so nothing was changed.` });
    } else {
      setRefreshNote({ ok: false, text: "Couldn't refresh the catalog. Nothing changed. Try again in a moment." });
    }
    await Promise.all([status.reload(), results.reload()]);
    setRefreshing(false);
  }

  // ---------------------------------------------------------------- picking a game and its regions

  function pick(group: GameGroup) {
    setGame(group);
    setName(group.name);
    setRegions(Object.fromEntries(group.regions.map((r) => [r.category_id, initialRegionState(r)])));
    setArt(null);
    setArtError(null);
    setGallery([]);
    setGalleryError(null);
    setCats([]);
    setCatError(null);
    setProblems([]);
    setError(null);
    setPriceNote(null);
  }

  const patchRegion = (id: string, patch: Partial<RegionState>) =>
    setRegions((current) => (current[id] ? { ...current, [id]: { ...current[id], ...patch } } : current));

  async function fetchRegion(row: CatalogRow) {
    const id = row.category_id;
    patchRegion(id, { busy: true, notice: null });
    const out = await loadOffers(row.supplier ?? supplier, row.family, id);
    setRegions((current) => (current[id] ? { ...current, [id]: applyOutcome(current[id], row, out) } : current));
  }

  // ---------------------------------------------------------------- artwork and save

  async function chooseArt() {
    setArtError(null);
    try {
      const picked = await pickArtwork();
      if (picked) setArt(picked);
    } catch {
      setArtError("Couldn't open your photos. Check that the app may use them, then try again.");
    }
  }

  async function addGalleryImage() {
    setGalleryError(null);
    try {
      const picked = await pickArtwork();
      if (picked) setGallery((current) => [...current, { key: `${Date.now()}-${current.length}`, picked }]);
    } catch {
      setGalleryError("Couldn't open your photos. Check that the app may use them, then try again.");
    }
  }

  function addCategory(label: string): boolean {
    if (cats.some((c) => c.label.toLowerCase() === label.toLowerCase())) {
      setCatError('You already have a category with that name.');
      return false;
    }
    setCatError(null);
    setCats((current) => [...current, { key: categoryKeyFor(label, new Set(current.map((c) => c.key))), label }]);
    return true;
  }

  function removeCategory(key: string) {
    setCatError(null);
    setCats((current) => current.filter((c) => c.key !== key));
    // Packs that were in it are unassigned, so you choose again (with two or more categories every pack needs one).
    setRegions((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, state]) => [
          id,
          { ...state, packs: Object.fromEntries(Object.entries(state.packs).map(([ref, p]) => [ref, p.categoryKey === key ? { ...p, categoryKey: null } : p])) },
        ])
      )
    );
  }

  function choicesOf(group: GameGroup): RegionChoice[] {
    return group.regions
      .filter((r) => regions[r.category_id]?.ticked)
      .map((r) => {
        const state = regions[r.category_id];
        const codes = parseRegionCodes(state.codesText);
        return {
          row: effectiveRow(r, state),
          label: state.label,
          codes: codes.codes,
          invalidCodes: codes.invalid,
          packs: (state.data?.offers ?? [])
            .filter((o) => state.packs[o.ref]?.ticked)
            .map((offer) => ({ offer, price: parsePrice(state.packs[offer.ref].price), categoryKey: state.packs[offer.ref].categoryKey ?? null })),
        };
      });
  }

  async function save() {
    if (!game || saving) return;
    setError(null);
    const plan = buildImportPayload({ name, imageUrl: null, regions: choicesOf(game), categories: cats, imagePaths: gallery.map((g) => g.key) });
    if (!plan.ok) {
      setProblems(plan.problems);
      return;
    }
    setProblems([]);
    setSaving(true);

    // Everything uploaded so far, so a failure anywhere removes it again (storage can't join the database transaction).
    const uploadedPaths: string[] = [];
    try {
      let bannerUrl: string | null = null;
      if (art) {
        try {
          const up = await uploadArtwork(await prepareArtwork(art));
          uploadedPaths.push(up.path);
          bannerUrl = up.url;
        } catch {
          setError("Couldn't upload the banner image, so nothing was imported. Try another image, or remove it and save without one.");
          return;
        }
      }
      const cardPaths: string[] = [];
      for (const [i, item] of gallery.entries()) {
        try {
          const up = await uploadArtwork(await prepareArtwork(item.picked, CARD_IMAGE_MAX_SIDE));
          uploadedPaths.push(up.path);
          cardPaths.push(up.path);
        } catch {
          setError(`Couldn't upload card image ${i + 1}, so nothing was imported. Remove it or try another image.`);
          return;
        }
      }
      const payload = {
        ...plan.payload,
        image_url: bannerUrl,
        ...(cardPaths.length > 0 ? { images: cardPaths.map((path) => ({ path })) } : {}),
      };
      const id = await importProduct(payload);
      uploadedPaths.length = 0; // saved with the product: nothing to clean up
      toast('Imported. Everything is switched off.');
      router.replace({ pathname: '/edit-product/[id]', params: { id } });
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      if (uploadedPaths.length > 0) await removeArtworkPaths(uploadedPaths);
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------- what is on screen

  const tickedRows = game ? game.regions.filter((r) => regions[r.category_id]?.ticked) : [];
  const tickedPacks = tickedRows.reduce((n, r) => {
    const state = regions[r.category_id];
    return n + (state.data?.offers ?? []).filter((o) => state.packs[o.ref]?.ticked).length;
  }, 0);
  const preview = game ? buildImportPayload({ name, imageUrl: null, regions: choicesOf(game), categories: cats }) : null;
  const staleWarnings = game
    ? stalePriceWarnings(tickedRows.map((r) => ({ label: regions[r.category_id].label.trim() || r.name, fetchedAt: regions[r.category_id].data?.fetchedAt ?? null })))
    : [];
  const warnings = preview && preview.ok ? preview.warnings : [];

  const s = status.data;
  const searching = debounced.length >= 2;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <Column>
          <ScreenHeader title="Import from supplier" onBack={game ? () => setGame(null) : undefined} />

          {!game && (
            <>
              <Text style={styles.section}>Supplier</Text>
              <PillGroup
                label="Supplier"
                value={supplier}
                options={SUPPLIERS.map((id) => ({ id, label: SUPPLIER_LABEL[id] }))}
                onChange={(next) => {
                  setSupplier(next);
                  setRefreshNote(null);
                }}
              />
              <View style={[styles.card, styles.afterPills]}>
                <Text style={styles.cardTitle}>{`Saved ${SUPPLIER_LABEL[supplier]} catalog`}</Text>
                {status.status === 'loading' && !s && <ActivityIndicator color={colors.limeDeep} style={styles.spinner} />}
                {status.status === 'error' && !s && <Text style={styles.muted}>{"Couldn't read the saved catalog. Go back and open this screen again."}</Text>}
                {s && s.categories === 0 && (
                  <Text style={styles.muted}>{`Nothing is saved from ${SUPPLIER_LABEL[supplier]} yet. Refresh the catalog to load it.`}</Text>
                )}
                {s && s.categories > 0 && (
                  <>
                    <FreshnessPill prefix="Catalog listed" iso={s.refreshedAt} neverText="Catalog never listed" />
                    <Text style={styles.muted}>
                      {`${s.categories} categories saved, ${s.blocked} hidden because they ask for a game password. Prices are saved for ${s.withPacks} of them, each with its own date.`}
                    </Text>
                    {staleLevel(s.refreshedAt) !== 'fresh' && (
                      <Text style={styles.staleNote}>
                        The supplier changes its catalog (categories get added and removed), so this list may not match it any more. Refresh it when you can.
                      </Text>
                    )}
                  </>
                )}
                <Button
                  label="Refresh catalog"
                  variant="outline"
                  onPress={onRefreshCatalog}
                  loading={refreshing}
                  style={styles.refreshButton}
                />
                {refreshNote &&
                  (refreshNote.ok ? (
                    <Text style={styles.okNote} accessibilityRole="alert">{refreshNote.text}</Text>
                  ) : (
                    <ErrorBanner message={refreshNote.text} />
                  ))}
              </View>

              <SearchBar value={query} onChangeText={setQuery} onSubmit={search.flush} placeholder="Search games and gift cards" />

              {!searching && !search.pending && <Text style={styles.hint}>{'Type at least two letters, for example "free fire" or "steam".'}</Text>}
              {search.pending && query.trim().length >= 2 && <Text style={styles.hint}>Searching when you stop typing… (Enter searches now)</Text>}
              {searching && results.status === 'loading' && !results.data && <ActivityIndicator color={colors.limeDeep} style={styles.spinner} />}
              {searching && results.status === 'error' && !results.data && (
                <ErrorBanner message="Couldn't search the saved catalog. Check your connection and try again." />
              )}
              {searching && results.status === 'ready' && groups.length === 0 && (
                <Text style={styles.hint}>
                  {s && s.categories === 0 ? `The saved ${SUPPLIER_LABEL[supplier]} catalog is empty. Refresh it above.` : `Nothing in the catalog matches "${debounced}".`}
                </Text>
              )}
              {(results.data?.length ?? 0) >= SEARCH_LIMIT && (
                <Text style={styles.hint}>Showing the first {SEARCH_LIMIT} matches. Type more to narrow it down.</Text>
              )}

              <View style={styles.list}>
                {groups.map((group) => (
                  <GroupRow key={group.key} group={group} onPress={() => pick(group)} />
                ))}
              </View>
            </>
          )}

          {game && (
            <>
              <Text style={styles.section}>Product</Text>
              <Text style={styles.hint}>
                {`Supplier: ${SUPPLIER_LABEL[game.regions[0]?.supplier ?? supplier]}. Orders are still fulfilled by hand: nothing is ordered from any supplier automatically.`}
              </Text>
              <TextField label="Product name" value={name} onChangeText={setName} maxLength={120} autoCapitalize="words" />

              <Text style={styles.section}>Categories (optional)</Text>
              <Text style={styles.hint}>
                {'For example UC, Coins or Membership. With two or more, customers get a pill for each above "Choose an amount", and every pack must be put in one below.'}
              </Text>
              <View style={styles.block}>
                <CategoriesEditor
                  items={cats.map((c) => ({ id: c.key, label: c.label }))}
                  max={MAX_CATEGORIES}
                  busy={saving}
                  error={catError}
                  onAdd={addCategory}
                  onRemove={removeCategory}
                />
              </View>

              <Text style={styles.section}>Regions and packs</Text>
              <Text style={styles.hint}>
                Each region is one supplier category. Tick the ones you want and pick the packs. Each pack is priced at its USD cost x the rate
                below x its own markup (use its - and + to change that pack only); you can also type any price yourself, and a price you type is
                never changed by the rate or a markup. Wholesale costs are in USD and only you can see them.
              </Text>
              <ExchangeRateField
                rateText={rateText}
                savedRate={rate.data}
                rateValid={rateValue !== null}
                unreadable={rate.status === 'error' && rate.data === null}
                onChange={changeRate}
                onSave={onSaveRate}
                onRetry={rate.reload}
                saving={savingRate}
                error={rateError}
                note={priceNote}
                disabled={saving}
              />
              {game.regions.map((row) => (
                <ImportRegionPacks
                  key={row.category_id}
                  row={row}
                  state={regions[row.category_id] ?? initialRegionState(row)}
                  onChange={(patch) => patchRegion(row.category_id, patch)}
                  onRefresh={() => fetchRegion(row)}
                  categories={cats}
                  rate={rateValue}
                />
              ))}

              <Text style={styles.section}>Banner image</Text>
              <ArtworkPicker picked={art} onPick={chooseArt} onRemove={() => setArt(null)} disabled={saving} error={artError} />

              <Text style={styles.section}>Images for pack cards (optional)</Text>
              <Text style={styles.hint}>
                Add as many as you like. Each is cropped square and shrunk to {CARD_IMAGE_MAX_SIDE}px. After importing you choose one for
                each pack on the edit screen.
              </Text>
              <View style={styles.block}>
                <ImageGallery
                  items={gallery.map((g) => ({ key: g.key, uri: g.picked.uri }))}
                  onAdd={addGalleryImage}
                  onRemove={(key) => setGallery((current) => current.filter((g) => g.key !== key))}
                  busy={saving}
                  max={MAX_GALLERY_IMAGES}
                  error={galleryError}
                  emptyText="No card images yet."
                />
              </View>

              <View style={styles.summary}>
                <Text style={styles.summaryTitle}>
                  {tickedRows.length} region{tickedRows.length === 1 ? '' : 's'}, {tickedPacks} pack{tickedPacks === 1 ? '' : 's'}
                </Text>
                <Text style={styles.muted}>
                  Everything is saved switched off. You check it on the product page and switch it on yourself.
                </Text>
                {staleWarnings.map((w) => (
                  <Text key={w} style={styles.staleWarning}>{w}</Text>
                ))}
                {warnings.map((w) => (
                  <Text key={w} style={styles.warning}>{w}</Text>
                ))}
              </View>

              {problems.length > 0 && <ErrorBanner message={problems.join('\n')} />}
              {error && <ErrorBanner message={error} />}
              <Button label="Import (everything switched off)" onPress={save} loading={saving} disabled={tickedRows.length === 0} />
            </>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

function GroupRow({ group, onPress }: { group: GameGroup; onPress: () => void }) {
  const range = formatUsdRange(costRange(group.regions.flatMap((r) => r.offers ?? [])));
  const regions = group.regions.length;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${group.name}, ${FAMILY_LABEL[group.family]}, ${regions} region${regions === 1 ? '' : 's'}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {group.name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={2}>
          {FAMILY_LABEL[group.family]}  ·  {regions} region{regions === 1 ? '' : 's'}  ·  cost {range}
        </Text>
        <Text style={styles.rowRegions} numberOfLines={1}>
          {group.regions.map((r) => r.region_label ?? 'Standard').join(', ')}
        </Text>
        <View style={styles.rowAge}>
          <FreshnessPill compact prefix="Prices saved" iso={oldestDate(group.regions.map((r) => r.offers_fetched_at))} neverText="No prices saved yet" />
        </View>
      </View>
      <FeatherIcon name="chevron-right" size={20} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  card: {
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  cardTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  muted: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  refreshButton: { marginTop: spacing.sm },
  staleNote: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  okNote: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 19, color: colors.limeInk },
  spinner: { marginVertical: spacing.md },
  hint: { marginVertical: spacing.md, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  list: { gap: spacing.sm + 2 },
  afterPills: { marginTop: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 76,
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.8 },
  rowText: { flex: 1 },
  rowName: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  rowMeta: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  rowRegions: { marginTop: 2, fontFamily: fonts.medium, fontSize: 12, color: colors.limeInk },
  rowAge: { marginTop: 6 },
  block: { padding: spacing.md, marginBottom: spacing.sm, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  section: { marginTop: spacing.lg, marginBottom: spacing.sm, fontFamily: fonts.extrabold, fontSize: 18, color: colors.text },
  summary: {
    marginVertical: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.limeSoft,
    gap: 6,
  },
  summaryTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.limeDark },
  warning: { fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 18, color: colors.limeDark },
  staleWarning: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 19, color: '#6B4700' },
});
