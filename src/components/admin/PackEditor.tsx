import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { checkLock, lockLabel, lockState, switchOnBlocker } from '../../lib/adminCatalog';
import { adminErrorMessage, updateOption, type AdminCategory, type AdminImage, type AdminOption } from '../../lib/admin';
import { calcPrice, impliedPercent, parsePercent, stepPercent, type Rate } from '../../lib/priceCalc';
import { parsePrice } from '../../lib/format';
import { checkPrices, priceCheckMessage, priceSummary } from '../../lib/pricing';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { MarkupStepper } from './MarkupStepper';
import { PillGroup } from '../ui/PillGroup';
import { TextField } from '../ui/TextField';
import { Toggle } from '../ui/Toggle';

export type PackDraft = { label: string; price: string; oldPrice: string; imageUrl: string | null; categoryId: string | null };

/** What the fields show when nothing has been typed yet. */
export function draftOf(pack: AdminOption): PackDraft {
  return {
    label: pack.label,
    price: String(pack.price),
    oldPrice: pack.old_price === null ? '' : String(pack.old_price),
    imageUrl: pack.image_url,
    categoryId: pack.category_id,
  };
}

type Props = {
  pack: AdminOption;
  draft: PackDraft;
  onDraft: (draft: PackDraft | null) => void;
  onChanged: () => void;
  /** The on/off switch is controlled by the screen: tapping it saves nothing until the screen's Save. */
  active: boolean;
  activeChanged: boolean;
  onActive: (next: boolean) => void;
  /** The product's uploaded images, to choose this pack's picture from. */
  gallery: readonly AdminImage[];
  categories: readonly AdminCategory[];
  /** The shared exchange rate (birr per US dollar), or null when it could not be read. With the pack's cost it drives the markup stepper. */
  rate: Rate;
};

const NO_CATEGORY = '__none__';

/**
 * One pack: label, price, old price (with a live preview of what customers will see), which image and category it
 * belongs to, on/off, and the region lock. Everything is checked here with the same rules the database enforces, so
 * the problem is explained before a save is ever refused.
 */
export function PackEditor({ pack, draft, onDraft, onChanged, active, activeChanged, onActive, gallery, categories, rate }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const [lockOn, setLockOn] = useState(pack.region_locked);
  const [codesText, setCodesText] = useState(pack.account_region_codes.join(', '));
  // This pack's markup. A saved pack stores only its price, so until the stepper is used the markup shown is the one the price
  // already contains; typing a price yourself hands the number back to that (null).
  const [markup, setMarkup] = useState<number | null>(null);
  const cost = pack.supplier_cost_usd;
  const typedPrice = parsePrice(draft.price);
  const impliedNow = cost !== null && typedPrice !== null ? impliedPercent(typedPrice, cost, rate) : null;
  const canMarkup = cost !== null && rate !== null;
  const markupShown = markup ?? impliedNow;
  const setMarkupPercent = (percent: number) => {
    if (cost === null || rate === null) return;
    const price = calcPrice(cost, rate, percent);
    if (price === null) return;
    setMarkup(percent);
    onDraft({ ...draft, price: String(price) });
  };

  const check = checkPrices(draft.price, draft.oldPrice);
  const saved = draftOf(pack);
  const dirty =
    draft.label.trim() !== saved.label ||
    draft.price.trim() !== saved.price ||
    draft.oldPrice.trim() !== saved.oldPrice ||
    draft.imageUrl !== saved.imageUrl ||
    draft.categoryId !== saved.categoryId;

  const priceError = !check.ok && check.reason.startsWith('price') ? priceCheckMessage(check) : null;
  const oldPriceError = !check.ok && check.reason.startsWith('old_price') ? priceCheckMessage(check) : null;
  const preview = check.ok ? priceSummary(check.price, check.oldPrice) : priceSummary(pack.price, pack.old_price);
  const lock = lockState(pack);
  // A saved image that is no longer in the gallery is shown as "none": the database has already cleared it.
  const imageIsKnown = draft.imageUrl === null || gallery.some((g) => g.url === draft.imageUrl);

  async function run(action: () => Promise<void>, done: string) {
    setMessage(null);
    setBusy(true);
    try {
      await action();
      toast(done);
      onChanged();
    } catch (err) {
      setMessage(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!check.ok || draft.label.trim() === '') {
      setMessage(check.ok ? 'Give the pack a name.' : priceCheckMessage(check));
      return;
    }
    await run(async () => {
      await updateOption(pack.id, {
        label: draft.label.trim(),
        price: check.price,
        old_price: check.oldPrice,
        image_url: draft.imageUrl,
        category_id: draft.categoryId,
      });
      onDraft(null);
    }, 'Saved');
  }

  function toggle(next: boolean) {
    if (next) {
      const blocker = switchOnBlocker(pack);
      if (blocker) return setMessage(blocker);
    }
    setMessage(null);
    onActive(next);
  }

  async function saveLock() {
    const lockCheck = checkLock(lockOn, codesText);
    if (!lockCheck.ok) return setMessage(lockCheck.message);
    await run(async () => {
      await updateOption(pack.id, { region_locked: lockCheck.region_locked, account_region_codes: lockCheck.account_region_codes });
      setLockOpen(false);
    }, 'Region lock saved');
  }

  return (
    <View style={[styles.card, !active && styles.cardOff, activeChanged && styles.cardChanged]} accessibilityLabel={`Pack ${pack.label}`}>
      <TextField
        label="Pack"
        value={draft.label}
        onChangeText={(v) => onDraft({ ...draft, label: v })}
        editable={!busy}
        accessibilityLabel={`Name of ${pack.label}`}
      />

      <View style={styles.row}>
        <View style={styles.half}>
          <TextField
            label="Price (Br)"
            value={draft.price}
            onChangeText={(v) => {
              setMarkup(null);
              onDraft({ ...draft, price: v });
            }}
            keyboardType="decimal-pad"
            editable={!busy}
            error={priceError}
            accessibilityLabel={`Price for ${pack.label}`}
          />
        </View>
        <View style={styles.half}>
          <TextField
            label="Old price (Br)"
            value={draft.oldPrice}
            onChangeText={(v) => onDraft({ ...draft, oldPrice: v })}
            keyboardType="decimal-pad"
            placeholder="none"
            editable={!busy}
            error={oldPriceError}
            accessibilityLabel={`Old price for ${pack.label}`}
          />
        </View>
      </View>

      {canMarkup && (
        <View style={styles.markupRow}>
          <Text style={styles.fieldLabel}>Markup on cost</Text>
          {markupShown === null ? (
            <Text style={styles.hint}>Type a price to see the markup it contains.</Text>
          ) : (
            <MarkupStepper
              percent={markupShown}
              onPercent={(p) => setMarkupPercent(p)}
              onStep={(direction) => setMarkupPercent(stepPercent(markupShown, direction))}
              packName={pack.label}
              disabled={busy}
            />
          )}
          {markupShown !== null && parsePercent(String(markupShown)) === null && (
            <Text style={styles.hint}>This price is far from the calculator&apos;s. Step the markup to bring it in range.</Text>
          )}
        </View>
      )}

      <Text style={styles.preview} accessibilityLabel={`Customers see: ${preview}`}>
        Customers see: <Text style={styles.previewValue}>{preview}</Text>
      </Text>

      <Text style={styles.fieldLabel}>Card image</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imageRow} keyboardShouldPersistTaps="handled">
        <ImageChoice label="No image" selected={draft.imageUrl === null || !imageIsKnown} onPress={() => onDraft({ ...draft, imageUrl: null })} disabled={busy} />
        {gallery.map((image, i) => (
          <ImageChoice
            key={image.id}
            label={`Image ${i + 1}`}
            uri={image.url}
            selected={draft.imageUrl === image.url}
            onPress={() => onDraft({ ...draft, imageUrl: image.url })}
            disabled={busy}
          />
        ))}
      </ScrollView>
      {gallery.length === 0 && <Text style={styles.hint}>Add images to the product first (the Images section above), then choose one here.</Text>}

      {categories.length > 0 && (
        <View style={styles.categoryBlock}>
          <Text style={styles.fieldLabel}>Category</Text>
          <PillGroup
            label={`Category for ${pack.label}`}
            options={[{ id: NO_CATEGORY, label: 'None' }, ...categories.map((c) => ({ id: c.id, label: c.label }))]}
            value={draft.categoryId ?? NO_CATEGORY}
            onChange={(id) => onDraft({ ...draft, categoryId: id === NO_CATEGORY ? null : id })}
          />
          {draft.categoryId === null && categories.length >= 2 && (
            <Text style={styles.hint}>A pack with no category is shown under the first category.</Text>
          )}
        </View>
      )}

      <View style={styles.meta}>
        {pack.supplier_cost_usd !== null && <Text style={styles.metaText}>Cost ${pack.supplier_cost_usd}</Text>}
        <Text style={[styles.metaText, lock === 'locked_no_codes' && styles.warn]}>{lockLabel(pack)}</Text>
        <Pressable
          onPress={() => setLockOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={`Edit region lock for ${pack.label}`}
          style={styles.linkBox}
        >
          <Text style={styles.link}>{lockOpen ? 'Close' : 'Region lock'}</Text>
        </Pressable>
      </View>

      {pack.missing_upstream && (
        <View style={styles.flag} accessibilityRole="alert">
          <Text style={styles.flagText}>
            The supplier no longer lists this offer. It stays on sale but will fail when a customer orders it.
          </Text>
        </View>
      )}

      {lockOpen && (
        <View style={styles.lockBox}>
          <View style={styles.switchRow}>
            <Text style={styles.strong}>Only for accounts in these regions</Text>
            <Toggle value={lockOn} onValueChange={setLockOn} label={`Region lock for ${pack.label}`} />
          </View>
          <TextField
            label="Account regions the ID check returns (e.g. ME, BR, ID)"
            value={codesText}
            onChangeText={setCodesText}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy && lockOn}
            accessibilityLabel={`Account regions for ${pack.label}`}
          />
          <Button label="Save region lock" variant="outline" onPress={saveLock} loading={busy} />
        </View>
      )}

      {message ? (
        <Text style={styles.error} accessibilityRole="alert">
          {message}
        </Text>
      ) : null}

      <View style={styles.footer}>
        <View style={styles.switchInline}>
          <Toggle value={active} onValueChange={toggle} label={`${pack.label} on sale`} />
          <Text style={styles.metaText}>
            {active ? 'On sale' : 'Off'}
            {activeChanged ? '  ·  unsaved' : ''}
          </Text>
        </View>
        {dirty ? (
          <View style={styles.saveWrap}>
            <Button label="Save" onPress={save} loading={busy} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ImageChoice({ label, uri, selected, onPress, disabled }: { label: string; uri?: string; selected: boolean; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, pressed && { opacity: 0.8 }]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityIgnoresInvertColors />
      ) : (
        <Text style={styles.choiceNone}>None</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm + 2,
  },
  cardOff: { opacity: 0.8 },
  cardChanged: { borderColor: '#EBCB7A' },
  row: { flexDirection: 'row', gap: spacing.sm + 4 },
  half: { flex: 1 },
  preview: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.textMuted, marginBottom: spacing.sm },
  previewValue: { fontFamily: fonts.bold, color: colors.limeInk },
  fieldLabel: { fontFamily: fonts.semibold, fontSize: 13.5, color: colors.limeInk, marginBottom: 7 },
  imageRow: { gap: spacing.sm, paddingBottom: spacing.xs, paddingRight: spacing.md },
  choice: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceSelected: { borderColor: colors.limeDeep, backgroundColor: colors.limeSoft },
  choiceNone: { fontFamily: fonts.bold, fontSize: 12, color: colors.textMuted },
  categoryBlock: { marginTop: spacing.sm, marginBottom: spacing.xs },
  hint: { marginTop: 4, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  markupRow: { marginBottom: spacing.xs, gap: 2 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm + 4, marginBottom: spacing.sm, marginTop: spacing.sm },
  metaText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  warn: { color: colors.danger },
  linkBox: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  link: { fontFamily: fonts.bold, fontSize: 13, color: colors.limeInk },
  flag: { padding: spacing.sm + 2, borderRadius: radius.sm, backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: colors.dangerBorder, marginBottom: spacing.sm },
  flagText: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.danger },
  lockBox: { padding: spacing.md - 2, borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.sm },
  strong: { flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  error: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.danger, marginBottom: spacing.sm },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  switchInline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  saveWrap: { flex: 1, maxWidth: 160 },
});
