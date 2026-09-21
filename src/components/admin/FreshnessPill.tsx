import { StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '../../lib/format';
import { ageText, staleLevel } from '../../lib/importPlan';
import { colors, fonts, radius } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

// Fresh reads calm; anything past a day reads as a warning, and past a week as an error.
const TONES = {
  fresh: { bg: colors.limeSoft, fg: colors.limeDark },
  aging: { bg: '#FFF1CC', fg: '#6B4700' },
  old: { bg: colors.dangerBg, fg: colors.danger },
  never: { bg: colors.dangerBg, fg: colors.danger },
} as const;

type Props = {
  /** "Prices saved" -> "Prices saved 2 days ago". */
  prefix: string;
  iso: string | null;
  /** Shown when there is no date at all. */
  neverText: string;
  /** Smaller, for rows in a list. */
  compact?: boolean;
};

/** How old saved supplier data is, in words and colour, with the exact date underneath. Never hidden. */
export function FreshnessPill({ prefix, iso, neverText, compact = false }: Props) {
  const level = staleLevel(iso);
  const tone = TONES[level];
  const words = iso ? `${prefix} ${ageText(iso)}` : neverText;
  const date = iso ? formatDateTime(iso) : null;

  return (
    <View
      accessible
      accessibilityLabel={date ? `${words}, on ${date}` : words}
      style={[styles.pill, compact && styles.compact, { backgroundColor: tone.bg }]}
    >
      <FeatherIcon name={level === 'fresh' ? 'clock' : 'alert-triangle'} size={compact ? 14 : 18} color={tone.fg} strokeWidth={2.4} />
      <View style={styles.texts}>
        <Text style={[compact ? styles.wordsCompact : styles.words, { color: tone.fg }]}>{words}</Text>
        {date && !compact && <Text style={[styles.date, { color: tone.fg }]}>{date}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    alignSelf: 'stretch',
  },
  compact: { alignSelf: 'flex-start', gap: 6, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill },
  texts: { flexShrink: 1 },
  words: { fontFamily: fonts.bold, fontSize: 14.5, lineHeight: 20 },
  wordsCompact: { fontFamily: fonts.bold, fontSize: 12, lineHeight: 16 },
  date: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 16, opacity: 0.85 },
});
