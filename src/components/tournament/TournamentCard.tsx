import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { phaseOf } from '../../lib/tournamentRules';
import type { Tournament } from '../../lib/tournaments';
import { FeatherIcon } from '../art/FeatherIcon';
import { entryLabel, formatLine, gameLabel, modeLabel, prizeText, whenText } from './labels';

type Props = { tournament: Tournament; now: number; onPress: () => void };

/** One tournament in a list: game and mode, the name, when, the format, the entry and what first place wins. */
export function TournamentCard({ tournament: tn, now, onPress }: Props) {
  const t = useT();
  const phase = phaseOf(tn.status, tn.startsAt, now);
  const closed = phase === 'cancelled' || phase === 'finished';
  const prize = prizeText(t, tn.firstPlace.money, tn.firstPlace.products);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${tn.name}. ${gameLabel(t, tn.game)}, ${modeLabel(t, tn.mode)}. ${formatDateTime(tn.startsAt)}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed, closed && styles.closed]}
    >
      <View style={styles.top}>
        <View style={styles.icon}>
          <FeatherIcon name={tn.kind === 'live' ? 'radio' : 'award'} size={20} color={colors.limeDark} />
        </View>
        <View style={styles.topText}>
          <Text style={styles.game} numberOfLines={1}>
            {gameLabel(t, tn.game)} · {modeLabel(t, tn.mode)}
          </Text>
          <Text style={styles.name} numberOfLines={2}>
            {tn.name}
          </Text>
        </View>
        <View style={[styles.when, phase === 'upcoming' ? styles.whenSoon : phase === 'started' ? styles.whenLive : styles.whenClosed]}>
          <Text style={[styles.whenText, phase === 'started' && styles.whenTextLive]} numberOfLines={1}>
            {whenText(t, tn.status, tn.startsAt, now)}
          </Text>
        </View>
      </View>

      <View style={styles.meta}>
        <Meta icon="calendar" text={formatDateTime(tn.startsAt)} />
        <Meta icon="users" text={formatLine(t, tn.teamSize, tn.teamCount)} />
        {tn.kind === 'register' ? <Meta icon="tag" text={entryLabel(t, tn.entryFee)} /> : <Meta icon="radio" text={t('tournament.kind.live')} />}
      </View>

      {prize ? (
        <View style={styles.prize}>
          <FeatherIcon name="award" size={15} color={colors.limeInk} />
          <Text style={styles.prizeText} numberOfLines={1}>
            {t('tournament.firstPlace', { prize })}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Meta({ icon, text }: { icon: 'calendar' | 'users' | 'tag' | 'radio'; text: string }) {
  return (
    <View style={styles.metaItem}>
      <FeatherIcon name={icon} size={13} color={colors.textMuted} />
      <Text style={styles.metaText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface, gap: spacing.sm + 2 },
  pressed: { backgroundColor: colors.border },
  closed: { opacity: 0.6 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm + 4 },
  icon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  topText: { flex: 1, minWidth: 0 },
  game: { fontFamily: fonts.semibold, fontSize: 12.5, color: colors.textMuted },
  name: { marginTop: 1, fontFamily: fonts.bold, fontSize: 16.5, lineHeight: 21, color: colors.text, letterSpacing: -0.2 },
  when: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.pill, maxWidth: 110 },
  whenSoon: { backgroundColor: colors.limeSoft },
  whenLive: { backgroundColor: colors.dangerBg },
  whenClosed: { backgroundColor: colors.border },
  whenText: { fontFamily: fonts.bold, fontSize: 12, color: colors.limeDark },
  whenTextLive: { color: colors.danger },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: 4 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  metaText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted, flexShrink: 1 },
  prize: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.bg,
  },
  prizeText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.limeInk, flexShrink: 1 },
});
