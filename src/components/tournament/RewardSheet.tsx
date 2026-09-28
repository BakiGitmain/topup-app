import { Image } from 'expo-image';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatBirr } from '../../lib/catalog';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { MAX_REWARD, parseBirr, type Reward } from '../../lib/tournamentRules';
import type { RewardPack } from '../../lib/tournaments';
import { FeatherIcon } from '../art/FeatherIcon';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/ErrorBanner';
import { PillGroup } from '../ui/PillGroup';
import { TextField } from '../ui/TextField';

type Props = {
  /** null = closed. */
  target: { place: number; slot: number; placeName: string; current: Reward | null } | null;
  teamSize: number;
  packs: RewardPack[] | null;
  packsFailed: boolean;
  onRetryPacks: () => void;
  onClose: () => void;
  /** everyone: the same reward for every player of that place. */
  onSave: (reward: Reward, everyone: boolean) => void;
};

const SHOWN = 40;

/** Choose one player's reward: an amount of money, or a pack from the shop. */
export function RewardSheet({ target, teamSize, packs, packsFailed, onRetryPacks, onClose, onSave }: Props) {
  const t = useT();
  const [kind, setKind] = useState<'money' | 'product'>('money');
  const [amount, setAmount] = useState('');
  const [packId, setPackId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(false);
  // Load the slot's current reward each time the sheet opens on a different slot.
  const key = target ? `${target.place}|${target.slot}` : null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (key !== openedFor) {
    setOpenedFor(key);
    const cur = target?.current ?? null;
    setKind(cur?.kind ?? 'money');
    setAmount(cur?.kind === 'money' ? String(cur.amount) : '');
    setPackId(cur?.kind === 'product' ? cur.optionId : null);
    setQuery('');
    setError(false);
  }

  function build(): Reward | null {
    if (kind === 'money') {
      const n = parseBirr(amount, { max: MAX_REWARD });
      return n === null ? null : { kind: 'money', amount: n };
    }
    const pack = packs?.find((p) => p.optionId === packId);
    if (pack) {
      return { kind: 'product', optionId: pack.optionId, productName: pack.productName, optionLabel: pack.optionLabel, regionLabel: pack.regionLabel, price: pack.price };
    }
    // The packs list hasn't loaded (or no longer lists it): keep what was already chosen for this slot as it was.
    const cur = target?.current;
    return cur?.kind === 'product' && cur.optionId === packId ? cur : null;
  }

  function save(everyone: boolean) {
    const reward = build();
    if (!reward) return setError(true);
    onSave(reward, everyone);
  }

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (packs ?? []).filter((p) => {
    const text = `${p.productName} ${p.optionLabel} ${p.regionLabel ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });

  return (
    <BottomSheet
      visible={!!target}
      onClose={onClose}
      title={target ? (teamSize === 1 ? target.placeName : t('tournament.reward.title', { place: target.placeName, n: target.slot })) : undefined}
    >
      <PillGroup
        label={t('tournament.host.chooseReward')}
        options={[
          { id: 'money', label: t('tournament.reward.money') },
          { id: 'product', label: t('tournament.reward.product') },
        ]}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setError(false);
        }}
      />
      <View style={styles.gap} />
      {error && <ErrorBanner message={kind === 'money' ? t('tournament.err.amount') : t('tournament.host.chooseReward')} />}

      {kind === 'money' ? (
        <TextField
          label={t('tournament.reward.amount')}
          value={amount}
          onChangeText={(v) => {
            setAmount(v);
            setError(false);
          }}
          keyboardType="decimal-pad"
          placeholder="500"
        />
      ) : (
        <>
          <TextField label={t('tournament.reward.search')} value={query} onChangeText={setQuery} autoCorrect={false} />
          {packsFailed && !packs ? (
            <Button label={t('common.retry')} variant="outline" onPress={onRetryPacks} />
          ) : !packs ? (
            <ActivityIndicator color={colors.limeInk} />
          ) : matches.length === 0 ? (
            <Text style={styles.none}>{t('tournament.reward.noPacks')}</Text>
          ) : (
            <View style={styles.packs}>
              {matches.slice(0, SHOWN).map((p) => {
                const on = packId === p.optionId;
                return (
                  <Pressable
                    key={p.optionId}
                    onPress={() => {
                      setPackId(p.optionId);
                      setError(false);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    style={({ pressed }) => [styles.pack, on && styles.packOn, pressed && styles.pressed]}
                  >
                    {p.imageUrl ? (
                      <Image source={{ uri: p.imageUrl }} style={styles.art} contentFit="cover" />
                    ) : (
                      <View style={[styles.art, styles.artEmpty]}>
                        <Text style={styles.artLetter}>{p.productName[0]?.toUpperCase()}</Text>
                      </View>
                    )}
                    <View style={styles.packText}>
                      <Text style={styles.packName} numberOfLines={1}>
                        {p.productName}
                        {p.regionLabel ? ` · ${p.regionLabel}` : ''}
                      </Text>
                      <Text style={styles.packLabel} numberOfLines={1}>
                        {p.optionLabel}
                      </Text>
                    </View>
                    <Text style={styles.price}>{formatBirr(p.price)}</Text>
                    {on && <FeatherIcon name="check-circle" size={18} color={colors.limeInk} />}
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      )}

      <Button label={t('tournament.reward.save')} onPress={() => save(false)} style={styles.save} />
      {teamSize > 1 && target && (
        <Button label={t('tournament.reward.saveAll', { place: target.placeName })} variant="outline" onPress={() => save(true)} style={styles.saveAll} />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  gap: { height: spacing.md },
  none: { marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 14, color: colors.textMuted },
  packs: { gap: spacing.xs + 2 },
  pack: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, padding: spacing.sm + 2, borderRadius: radius.md, borderWidth: 1.5, borderColor: 'transparent', backgroundColor: colors.surface },
  packOn: { borderColor: colors.limeInk, backgroundColor: colors.limeSoft },
  pressed: { backgroundColor: colors.border },
  art: { width: 36, height: 36, borderRadius: 10 },
  artEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border },
  artLetter: { fontFamily: fonts.bold, fontSize: 15, color: colors.textMuted },
  packText: { flex: 1, minWidth: 0 },
  packName: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  packLabel: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.text },
  price: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted },
  save: { marginTop: spacing.md },
  saveAll: { marginTop: spacing.sm },
});
