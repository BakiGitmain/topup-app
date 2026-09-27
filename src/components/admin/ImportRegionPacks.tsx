import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { parseRegionCodes } from '../../lib/adminCatalog';
import {
  costRange,
  formatUsd,
  formatUsdRange,
  regionDefaults,
  effectiveRow,
  ownValidation,
  crossSupplierValidation,
  resolvedValidation,
  SUPPLIER_LABEL,
  type CatalogOffer,
  type CatalogRow,
  type ImportCategory,
  type PackDraft,
  type RegionState,
  type SupplierName,
  type ValidationCandidate,
} from '../../lib/importPlan';
import { differsFromCalculated, percentOf, priceText, withPercent, withReset, withStep, withTick, withTypedPrice, type Rate } from '../../lib/priceCalc';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { CheckRow } from '../ui/CheckRow';
import { FreshnessPill } from './FreshnessPill';
import { MarkupStepper } from './MarkupStepper';
import { PillGroup } from '../ui/PillGroup';
import { TextField } from '../ui/TextField';

type Props = {
  row: CatalogRow;
  state: RegionState;
  onChange: (patch: Partial<RegionState>) => void;
  onRefresh: () => void;
  /** The product's categories, if any: each ticked pack can be put in one. */
  categories?: ImportCategory[];
  /** The shared exchange rate that pre-fills prices. Null when there is no usable rate: prices are then typed by hand. */
  rate: Rate;
  /** Every supplier's own validated category for this GAME (both suppliers, fetched once per game), for offering a
   * cross-supplier ID check when this row's own supplier can't check it (or a different one is preferred). */
  validationCandidates?: ValidationCandidate[];
};

export function ImportRegionPacks({ row, state, onChange, onRefresh, categories = [], rate, validationCandidates = [] }: Props) {
  const offers = state.data?.offers ?? row.offers ?? [];
  const range = formatUsdRange(costRange(offers));
  const title = row.region_label ?? row.name;

  return (
    <View style={[styles.card, state.ticked && styles.cardOn]}>
      <CheckRow
        checked={state.ticked}
        onChange={(ticked) => {
          onChange({ ticked });
          if (ticked && !state.data && !state.busy) onRefresh();
        }}
        label={`${title}${state.data ? `  ·  ${offers.length} packs  ·  cost ${range}` : ''}`}
      />
      {row.name !== title && <Text style={styles.sub}>{row.name}</Text>}
      {state.notice && <Text style={styles.notice} accessibilityRole="alert">{state.notice}</Text>}
      {!state.ticked && state.data && (
        <View style={styles.collapsedAge}>
          <FreshnessPill compact prefix="Prices saved" iso={state.data.fetchedAt} neverText="No prices saved yet" />
        </View>
      )}

      {state.ticked && (
        <Body row={row} state={state} onChange={onChange} onRefresh={onRefresh} offers={offers} categories={categories} rate={rate} validationCandidates={validationCandidates} />
      )}
    </View>
  );
}

function Body({ row, state, onChange, onRefresh, offers, categories = [], rate, validationCandidates = [] }: Props & { offers: CatalogOffer[] }) {
  const ownCheck = ownValidation(row);
  const crossCheck = crossSupplierValidation(row, validationCandidates);
  const resolvedCheck = resolvedValidation(ownCheck, crossCheck, state.validationChoice);
  const defaults = state.data ? regionDefaults(effectiveRow(row, state), resolvedCheck) : null;
  const parsed = parseRegionCodes(state.codesText);
  const fetchedAt = state.data?.fetchedAt ?? null;
  const tickedCount = offers.filter((o) => state.packs[o.ref]?.ticked).length;

  const setPack = (ref: string, patch: Partial<PackDraft>) =>
    onChange({ packs: { ...state.packs, [ref]: { ...(state.packs[ref] ?? { ticked: false, price: '' }), ...patch } } });
  // Ticking fills in the calculated price (unless the admin already typed one); typing makes the price theirs. Every pack has its
  // OWN markup: a press on one pack's stepper changes that pack only.
  const tickPack = (offer: CatalogOffer, ticked: boolean) =>
    onChange({ packs: { ...state.packs, [offer.ref]: withTick(state.packs[offer.ref], offer, rate, ticked) } });
  const stepPack = (offer: CatalogOffer, direction: 1 | -1) =>
    onChange({ packs: { ...state.packs, [offer.ref]: withStep(state.packs[offer.ref], offer, rate, direction) } });
  const percentPack = (offer: CatalogOffer, percent: number) =>
    onChange({ packs: { ...state.packs, [offer.ref]: withPercent(state.packs[offer.ref], offer, rate, percent) } });
  const typePrice = (ref: string, text: string) => onChange({ packs: { ...state.packs, [ref]: withTypedPrice(state.packs[ref], text) } });
  const resetPrice = (offer: CatalogOffer) => onChange({ packs: { ...state.packs, [offer.ref]: withReset(state.packs[offer.ref], offer, rate) } });
  const setAll = (ticked: boolean) =>
    onChange({ packs: Object.fromEntries(offers.map((o) => [o.ref, withTick(state.packs[o.ref], o, rate, ticked)])) });

  return (
    <View style={styles.body}>
      <TextField
        label="Region name customers see"
        value={state.label}
        onChangeText={(label) => onChange({ label })}
        maxLength={60}
        autoCapitalize="words"
      />

      <FreshnessPill prefix="Prices saved" iso={fetchedAt} neverText="No prices saved yet" />
      <View style={styles.freshRow}>
        <Pressable
          onPress={onRefresh}
          disabled={state.busy}
          accessibilityRole="button"
          accessibilityLabel={`Refresh prices for ${row.name}`}
          accessibilityState={{ disabled: state.busy, busy: state.busy }}
          style={({ pressed }) => [styles.refresh, pressed && styles.pressed, state.busy && styles.disabled]}
        >
          {state.busy ? <ActivityIndicator size="small" color={colors.limeDeep} /> : <FeatherIcon name="refresh-cw" size={16} color={colors.limeInk} strokeWidth={2.4} />}
          <Text style={styles.refreshText}>{state.busy ? 'Fetching' : 'Refresh prices'}</Text>
        </Pressable>
      </View>
      {ownCheck === null && crossCheck !== null && (
        <View style={styles.crossValidation}>
          <Text style={styles.fact}>
            {`${SUPPLIER_LABEL[row.supplier ?? 'fazercards']} can't check IDs for this game, but ${SUPPLIER_LABEL[crossCheck.supplier]} can. The packs still come from ${SUPPLIER_LABEL[row.supplier ?? 'fazercards']}.`}
          </Text>
          <PillGroup<'none' | SupplierName>
            label={`ID check for ${row.name}`}
            value={state.validationChoice === crossCheck.supplier ? crossCheck.supplier : 'none'}
            options={[
              { id: 'none', label: "Customers tick instead" },
              { id: crossCheck.supplier, label: `Validate with ${SUPPLIER_LABEL[crossCheck.supplier]}` },
            ]}
            onChange={(id) => onChange({ validationChoice: id === 'none' ? null : crossCheck.supplier })}
          />
        </View>
      )}
      {ownCheck !== null && crossCheck !== null && ownCheck.supplier !== crossCheck.supplier && (
        <View style={styles.crossValidation}>
          <Text style={styles.fact}>Both suppliers can check IDs for this game.</Text>
          <PillGroup<SupplierName>
            label={`ID check for ${row.name}`}
            value={resolvedCheck?.supplier ?? ownCheck.supplier}
            options={[
              { id: ownCheck.supplier, label: SUPPLIER_LABEL[ownCheck.supplier] },
              { id: crossCheck.supplier, label: SUPPLIER_LABEL[crossCheck.supplier] },
            ]}
            onChange={(id) => onChange({ validationChoice: id })}
          />
        </View>
      )}

      {defaults && (
        <View style={styles.facts}>
          <Text style={styles.fact}>
            {defaults.idMode === 'supplier' ? 'The supplier checks the player ID before a purchase.' : "Customers tick that they've checked their ID."}
          </Text>
          {defaults.idCheckNote && <Text style={styles.fact}>{defaults.idCheckNote}</Text>}
          <Text style={styles.fact}>
            {defaults.locked ? 'Region-locked: only accounts from the regions below can buy these packs.' : 'Not region-locked: any account can buy these packs.'}
          </Text>
        </View>
      )}

      {defaults?.locked && (
        <TextField
          label="Account regions allowed (for example ME)"
          value={state.codesText}
          onChangeText={(codesText) => onChange({ codesText })}
          autoCapitalize="characters"
          autoCorrect={false}
          error={
            parsed.invalid.length > 0
              ? `Not valid region codes: ${parsed.invalid.join(', ')}`
              : parsed.codes.length === 0
                ? 'Empty: these packs stay switched off until you add the account regions.'
                : null
          }
        />
      )}

      <View style={styles.packHead}>
        <Text style={styles.packTitle}>
          Packs ({tickedCount} of {offers.length} picked)
        </Text>
        <View style={styles.packActions}>
          <Pressable onPress={() => setAll(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Pick all packs in ${row.name}`}>
            <Text style={styles.link}>All</Text>
          </Pressable>
          <Pressable onPress={() => setAll(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Clear all packs in ${row.name}`}>
            <Text style={styles.link}>None</Text>
          </Pressable>
        </View>
      </View>

      {offers.length === 0 && !state.busy && <Text style={styles.sub}>Nothing to import here.</Text>}
      {offers.map((offer) => (
        <PackRow
          key={offer.ref}
          offer={offer}
          draft={state.packs[offer.ref]}
          rate={rate}
          onTick={(ticked) => tickPack(offer, ticked)}
          onStep={(direction) => stepPack(offer, direction)}
          onPercent={(percent) => percentPack(offer, percent)}
          onPrice={(text) => typePrice(offer.ref, text)}
          onReset={() => resetPrice(offer)}
          onChange={(patch) => setPack(offer.ref, patch)}
          categories={categories}
        />
      ))}
      {(state.data?.hidden ?? 0) > 0 && (
        <Text style={styles.sub}>
          {`${state.data?.hidden} pack${state.data?.hidden === 1 ? ' is' : 's are'} hidden (first-purchase offers work once per account, so they can't be sold).`}
        </Text>
      )}
    </View>
  );
}

function PackRow({
  offer,
  draft,
  rate,
  onTick,
  onStep,
  onPercent,
  onPrice,
  onReset,
  onChange,
  categories,
}: {
  offer: CatalogOffer;
  draft: PackDraft | undefined;
  rate: Rate;
  onTick: (ticked: boolean) => void;
  onStep: (direction: 1 | -1) => void;
  onPercent: (percent: number) => void;
  onPrice: (text: string) => void;
  onReset: () => void;
  onChange: (patch: Partial<PackDraft>) => void;
  categories: ImportCategory[];
}) {
  const [focused, setFocused] = useState(false);
  const ticked = draft?.ticked === true;
  return (
    <View style={styles.pack}>
      <CheckRow
        checked={ticked}
        onChange={onTick}
        label={`${offer.name}   ·   cost ${formatUsd(Number(offer.cost_usd))}${offer.stock === 0 ? '   ·   out of stock' : ''}`}
      />
      {ticked && (
        <View style={styles.priceRow}>
          <View style={[styles.priceBox, focused && styles.priceBoxFocused]}>
            <Text style={styles.currency}>Br</Text>
            <TextInput
              value={draft?.price ?? ''}
              onChangeText={onPrice}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              keyboardType={Platform.OS === 'web' ? 'default' : 'decimal-pad'}
              inputMode="decimal"
              placeholder="Price in birr"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel={`Price in birr for ${offer.name}`}
              style={styles.priceInput}
            />
          </View>
          <MarkupStepper percent={percentOf(draft)} onPercent={onPercent} onStep={onStep} packName={offer.name} />
        </View>
      )}
      {ticked && draft?.manual === true && differsFromCalculated(draft, offer, rate) && (
        <View style={styles.differs}>
          <Text style={styles.differsText}>{`Your price stays. At ${percentOf(draft)}% the calculator says Br ${priceText(offer.cost_usd, rate, percentOf(draft))}.`}</Text>
          <Pressable onPress={onReset} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Use the calculated price for ${offer.name}`} style={styles.resetHit}>
            <Text style={styles.link}>Use it</Text>
          </Pressable>
        </View>
      )}
      {ticked && categories.length > 0 && (
        <View style={styles.catRow} accessibilityRole="radiogroup" accessibilityLabel={`Category for ${offer.name}`}>
          {categories.map((c) => {
            const selected = draft?.categoryKey === c.key;
            return (
              <Pressable
                key={c.key}
                onPress={() => onChange({ categoryKey: selected ? null : c.key })}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={c.label}
                style={[styles.catPill, selected && styles.catPillOn]}
              >
                <Text style={[styles.catText, selected && styles.catTextOn]}>{c.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm + 2,
  },
  cardOn: { backgroundColor: colors.bg, borderColor: colors.limeDeep },
  sub: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted, marginBottom: spacing.sm },
  body: { paddingTop: spacing.xs, paddingBottom: spacing.sm },
  collapsedAge: { marginBottom: spacing.sm },
  freshRow: { flexDirection: 'row', justifyContent: 'flex-start', marginTop: spacing.xs, marginBottom: spacing.sm },
  refresh: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: colors.limeSoft,
  },
  refreshText: { fontFamily: fonts.bold, fontSize: 13, color: colors.limeDark },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.6 },
  notice: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.danger, marginBottom: spacing.sm },
  crossValidation: { gap: 6, marginBottom: spacing.md },
  facts: { gap: 4, marginBottom: spacing.md },
  fact: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  packHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xs, minHeight: 44 },
  packTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  packActions: { flexDirection: 'row', gap: spacing.md },
  link: { fontFamily: fonts.bold, fontSize: 14, color: colors.limeInk, paddingVertical: 10 },
  pack: { borderTopWidth: 1, borderTopColor: colors.border },
  // The price box and this pack's own stepper share a line, and wrap onto two on a narrow phone.
  priceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm, rowGap: spacing.xs, marginLeft: 38, marginBottom: spacing.sm },
  priceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 1,
    minWidth: 120,
    height: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  differs: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginLeft: 38, marginBottom: spacing.xs },
  differsText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  resetHit: { minHeight: 44, justifyContent: 'center' },
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginLeft: 38, marginBottom: spacing.sm },
  catPill: { minHeight: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  catPillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  catText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted },
  catTextOn: { color: colors.primaryText },
  priceBoxFocused: { borderColor: colors.limeDeep },
  currency: { fontFamily: fonts.bold, fontSize: 14, color: colors.textMuted, marginRight: 8 },
  priceInput: { flex: 1, height: '100%', fontFamily: fonts.semibold, fontSize: 15.5, color: colors.text },
});
