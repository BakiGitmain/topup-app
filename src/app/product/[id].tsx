import { Image } from 'expo-image';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionBar } from '../../components/product/ActionBar';
import { IdForm } from '../../components/product/IdForm';
import { PackageGrid } from '../../components/product/PackageGrid';
import { CartButton } from '../../components/cart/CartButton';
import { Chips } from '../../components/ui/Chips';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { cartErrorText, useCart } from '../../lib/cart';
import { sameFields } from '../../lib/cartApi';
import { needsAccountId } from '../../lib/catalog';
import { tileLetter } from '../../lib/catalogRules';
import { useT } from '../../lib/i18n';
import {
  continueBlocker,
  isFieldsComplete,
  normalizeFields,
  type BuyerField,
  type Blocker,
} from '../../lib/idValidation';
import { fetchLastFields } from '../../lib/orders';
import { formatBirr } from '../../lib/pricing';
import { fetchProductPage, type ProductDetail } from '../../lib/productPage';
import {
  categoryFilter,
  effectiveCategoryId,
  groupPackages,
  initialRegionId,
  needsRegionChips,
  packagesInRegion,
  sortRegions,
} from '../../lib/productView';
import { packageState, suggestRegion, type RegionGroup } from '../../lib/regionMatch';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';
import { useIdValidation } from '../../lib/useIdValidation';

const BLOCKER_TEXT: Record<Blocker, Parameters<ReturnType<typeof useT>>[0]> = {
  choose_package: 'product.blocker.choose',
  fill_fields: 'product.blocker.fill',
  checking: 'product.blocker.checking',
  invalid_id: 'product.blocker.invalid',
  check_failed: 'product.blocker.failed',
  check_expired: 'product.blocker.expired',
  confirm_id: 'product.blocker.confirm',
  wrong_region: 'product.blocker.wrongRegion',
  region_unknown: 'product.blocker.regionUnknown',
  package_unavailable: 'product.blocker.unavailable',
};

export default function ProductScreen() {
  const { id, optionId, accountId } = useLocalSearchParams<{
    id: string;
    optionId?: string;
    accountId?: string;
  }>();
  const { user, session, initializing } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();
  const cart = useCart();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [buying, setBuying] = useState(false);

  // Not before sign-in has finished, and never without an id (that would query id=eq.undefined).
  const page = useAsync(() => fetchProductPage(id), id ?? '', !initializing && !!session && !!id);

  const [regionChoice, setRegionChoice] = useState<string | null>(null);
  const [pickedRegionByHand, setPickedRegionByHand] = useState(false);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(optionId ?? null);
  const [categoryChoice, setCategoryChoice] = useState<string | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [lastFields, setLastFields] = useState<Record<string, string> | null>(null);
  const [ticked, setTicked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Pre-fill from the last order for this product; Buy again's own value wins for the first field.
  const userId = user?.id;
  useEffect(() => {
    if (!userId || !id) return;
    let active = true;
    fetchLastFields(userId, id)
      .then((fields) => {
        if (active) setLastFields(fields);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId, id]);

  useEffect(() => {
    if (__DEV__ && !id) console.warn('[product] screen opened without an id; sending you to the shop');
  }, [id]);

  // ---------------------------------------------------------------- what is on screen
  const data = page.data;
  const product = data?.product;
  const regions = sortRegions(data?.regions ?? []);
  const allPackages = data?.packages ?? [];

  const wanted = regionChoice && regions.some((r) => r.id === regionChoice) ? regionChoice : null;
  const activeRegionId = wanted ?? initialRegionId(regions, allPackages, optionId);
  const region = regions.find((r) => r.id === activeRegionId) ?? null;
  const packages = packagesInRegion(allPackages, region?.id ?? null);

  // Category pills (only when there is a real choice). Start on the category of a pre-selected pack, else the first.
  const categories = data?.categories ?? [];
  const preselected = allPackages.find((p) => p.id === selectedId);
  const startCategory = categoryChoice ?? (preselected ? effectiveCategoryId(preselected, categories) : null);
  const filtered = categoryFilter(packages, categories, startCategory);

  const buyerFields: BuyerField[] = region
    ? region.buyerFields
    : product && needsAccountId(product.category)
      ? [{ key: 'account_id', label: t('product.gameId'), type: 'text' }]
      : [];
  const idMode: 'supplier' | 'tick' | 'none' = region
    ? region.idValidation === 'supplier'
      ? 'supplier'
      : buyerFields.length > 0
        ? 'tick'
        : 'none'
    : 'none';

  const values: Record<string, string> = {};
  buyerFields.forEach((field, index) => {
    values[field.key] = edited[field.key] ?? (index === 0 ? accountId : undefined) ?? lastFields?.[field.key] ?? '';
  });
  const fieldsComplete = isFieldsComplete(buyerFields, values);

  const groups: RegionGroup[] = regions.map((r) => ({
    id: r.id,
    label: r.label,
    packages: packagesInRegion(allPackages, r.id).map((p) => ({
      regionLocked: p.regionLocked,
      accountRegionCodes: p.accountRegionCodes,
    })),
  }));

  // ---------------------------------------------------------------- the ID check
  const { check, retry } = useIdValidation({
    regionId: region?.id ?? null,
    buyerFields,
    values,
    enabled: idMode === 'supplier',
    onValid: ({ accountRegion }) => {
      // Region-locked packs going to the wrong region is the failure to avoid: pick the matching chip for them.
      if (pickedRegionByHand || regions.length < 2) return;
      const suggestion = suggestRegion(groups, activeRegionId, accountRegion);
      if (suggestion.kind === 'switch') {
        setRegionChoice(suggestion.region.id);
        setAutoNote(suggestion.region.label);
      }
    },
  });

  const accountRegion = check.kind === 'valid' ? check.accountRegion : null;
  const suggestion = check.kind === 'valid' && region ? suggestRegion(groups, region.id, accountRegion) : null;
  const anyLockedHere = packages.some((p) => p.regionLocked);

  const stateOf = (pkg: (typeof packages)[number]) =>
    packageState(pkg, { idMode, validated: check.kind === 'valid', accountRegion });

  // Where the supplier can check IDs, the pack list stays locked until the ID is confirmed. Other games have nothing to check,
  // so their packs are open (the ID field is still above them).
  const packsLocked = idMode === 'supplier' && check.kind !== 'valid';

  const selected = filtered.visible.find((p) => p.id === selectedId) ?? null;
  const blocker = continueBlocker({
    hasPackage: selected !== null,
    packageState: selected ? stateOf(selected) : 'pending',
    fieldsComplete,
    idMode,
    check,
    ticked,
  });

  // ---------------------------------------------------------------- actions
  function changeField(key: string, value: string) {
    setEdited((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  function chooseRegion(regionId: string) {
    setRegionChoice(regionId);
    setPickedRegionByHand(true);
    setAutoNote(null);
    setNotice(null);
  }

  function switchToSuggested(regionId: string) {
    setRegionChoice(regionId);
    setPickedRegionByHand(false);
    setAutoNote(null);
  }

  /**
   * Both buttons are gated by the same per-item ID check as before (blocker === null: the ID is checked, or ticked where the
   * supplier can't check it). The cart re-checks every line again at checkout.
   */
  const cartInput = () => ({
    optionId: selected?.id ?? '',
    fields: buyerFields.length > 0 ? normalizeFields(buyerFields, values) : {},
    idChecked: idMode === 'tick' && ticked,
  });

  /** The small cart button: put the pack (with THIS ID) in the cart and stay here to keep browsing. */
  async function onAddToCart() {
    if (!selected || blocker !== null || adding || buying) return;
    setNotice(null);
    setAdding(true);
    try {
      await cart.add(cartInput());
      toast(t('cart.added'));
    } catch (err) {
      setNotice(cartErrorText(err));
    } finally {
      setAdding(false);
    }
  }

  /** Buy now: make sure it is in the cart (not added twice if it already is), then go straight to checkout. */
  async function onBuyNow() {
    if (!selected || blocker !== null || adding || buying) return;
    setNotice(null);
    setBuying(true);
    try {
      const input = cartInput();
      const already = cart.lines.some((l) => l.optionId === input.optionId && sameFields(l.fields, input.fields));
      if (!already) await cart.add(input);
      router.push('/cart');
    } catch (err) {
      setNotice(cartErrorText(err));
    } finally {
      setBuying(false);
    }
  }

  // ---------------------------------------------------------------- guards
  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!id) return <Redirect href="/shop" />;

  const failedToLoad = page.status === 'error' || (page.status === 'ready' && !data);
  const total = selected ? formatBirr(selected.price) : '—';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Column>
            <ScreenHeader title={product?.name ?? ''} right={<CartButton />} />

            {page.status === 'loading' && !data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

            {failedToLoad && (
              <Text style={styles.notFound}>
                {page.status === 'error' ? t('common.loadError') : t('product.notFound')}
              </Text>
            )}

            {product && (
              <>
                <Hero product={product} />

                {needsRegionChips(regions) && (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('product.region')}</Text>
                    <Chips
                      options={regions.map((r) => ({ id: r.id, label: r.label }))}
                      value={region?.id ?? ''}
                      onChange={chooseRegion}
                    />
                    {autoNote !== null && <Text style={styles.autoNote}>{t('product.regionAuto', { region: autoNote })}</Text>}
                  </View>
                )}

                {notice !== null && <ErrorBanner message={notice} />}

                {buyerFields.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>{t('product.idTitle')}</Text>
                    <IdForm
                      fields={buyerFields}
                      values={values}
                      onChange={changeField}
                      mode={idMode}
                      check={check}
                      onRetry={retry}
                      ticked={ticked}
                      onTick={setTicked}
                      hint={t('product.gameIdHint')}
                    />
                  </View>
                )}

                {idMode === 'supplier' && check.kind === 'valid' && suggestion?.kind === 'switch' && (
                  <RegionNote
                    message={t('product.regionWrong', { account: accountRegion ?? '', region: region?.label ?? '' })}
                    actionLabel={t('product.regionSwitch', { region: suggestion.region.label })}
                    onAction={() => switchToSuggested(suggestion.region.id)}
                  />
                )}
                {idMode === 'supplier' && check.kind === 'valid' && suggestion?.kind === 'not_carried' && anyLockedHere && (
                  <RegionNote message={t('product.regionNone', { account: accountRegion ?? '' })} />
                )}
                {idMode === 'supplier' && check.kind === 'valid' && accountRegion === null && anyLockedHere && (
                  <RegionNote message={t('product.regionUnknown')} />
                )}

                {filtered.pills.length > 0 && (
                  <View style={styles.pills}>
                    <Chips
                      options={filtered.pills.map((c) => ({ id: c.id, label: c.label }))}
                      value={filtered.activeId ?? ''}
                      onChange={(id) => {
                        setCategoryChoice(id);
                        setNotice(null);
                      }}
                    />
                  </View>
                )}

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{t('product.choose')}</Text>
                  {packsLocked && (
                    <Text style={styles.lockHint} accessibilityLiveRegion="polite">
                      {t('product.idFirst')}
                    </Text>
                  )}
                  {/* Greyed out and untouchable until the ID has checked out: the account's region is only known then. */}
                  <View pointerEvents={packsLocked ? 'none' : 'auto'} style={packsLocked ? styles.packsLocked : undefined} accessibilityState={{ disabled: packsLocked }}>
                    <PackageGrid
                      groups={groupPackages(filtered.visible)}
                      selectedId={selected?.id ?? null}
                      onSelect={(pid) => {
                        if (packsLocked) return;
                        setSelectedId(pid);
                        setNotice(null);
                      }}
                      stateOf={stateOf}
                    />
                  </View>
                </View>

              </>
            )}
          </Column>
        </ScrollView>

        {product && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
            <Column>
              <ActionBar
                total={total}
                blockerText={blocker === null ? null : t(BLOCKER_TEXT[blocker])}
                adding={adding}
                buying={buying}
                onAdd={onAddToCart}
                onBuy={onBuyNow}
              />
            </Column>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** The product's artwork (or a tinted letter tile) with its name and, only if an admin wrote one, its description. */
function Hero({ product }: { product: ProductDetail }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = product.imageUrl;
  const showImage = url !== null && failedUrl !== url;

  return (
    <View style={styles.hero}>
      <View style={[styles.art, { backgroundColor: showImage ? colors.surface : product.tint }]}>
        {showImage ? (
          <Image
            source={{ uri: url }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={150}
            onError={(event) => {
              if (__DEV__) console.warn(`[artwork] failed to load for "${product.name}": ${url} (${event.error})`);
              setFailedUrl(url);
            }}
          />
        ) : (
          <Text style={styles.artLetter} allowFontScaling={false} importantForAccessibility="no">
            {tileLetter(product.name)}
          </Text>
        )}
      </View>
      <View style={styles.heroText}>
        <Text style={styles.heroName} numberOfLines={2}>
          {product.name}
        </Text>
        {product.description !== null && <Text style={styles.description}>{product.description}</Text>}
      </View>
    </View>
  );
}

function RegionNote({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <View style={styles.regionNote} accessibilityRole="alert">
      <Text style={styles.regionNoteText}>{message}</Text>
      {actionLabel && onAction && (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          style={({ pressed }) => [styles.regionNoteButton, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.regionNoteButtonText}>{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  packsLocked: { opacity: 0.4 },
  lockHint: { marginBottom: spacing.sm, fontFamily: fonts.medium, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { paddingBottom: spacing.xl },
  loading: { marginTop: spacing.xxl },
  notFound: {
    marginTop: spacing.xl,
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
  },
  hero: { marginBottom: spacing.lg },
  art: {
    height: 148,
    borderRadius: radius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  artLetter: { fontFamily: fonts.extrabold, fontSize: 64, color: colors.text, opacity: 0.45, includeFontPadding: false },
  heroText: { marginTop: spacing.md },
  heroName: { fontFamily: fonts.extrabold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  description: { marginTop: 6, fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.textMuted },
  section: { marginBottom: spacing.lg },
  pills: { marginBottom: spacing.md },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, marginBottom: spacing.sm + 4 },
  autoNote: { marginTop: spacing.sm, fontFamily: fonts.medium, fontSize: 13, color: colors.limeInk },
  regionNote: {
    padding: spacing.md - 2,
    borderRadius: radius.md,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  regionNoteText: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.danger },
  regionNoteButton: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.lime,
  },
  regionNoteButtonText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.text },
  footer: {
    paddingTop: spacing.sm + 2,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  success: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  successIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.limeSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  successTitle: { fontFamily: fonts.extrabold, fontSize: 26, color: colors.text, letterSpacing: -0.6 },
  successBody: {
    marginTop: spacing.sm,
    maxWidth: 300,
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    textAlign: 'center',
  },
  successMeta: {
    marginTop: spacing.md,
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: colors.limeInk,
    textAlign: 'center',
  },
  successButton: { alignSelf: 'stretch', marginTop: spacing.md },
});
