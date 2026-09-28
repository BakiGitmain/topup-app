import { StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import type { Tournament } from '../../lib/tournaments';
import { FeatherIcon } from '../art/FeatherIcon';
import { CopyButton } from '../ui/CopyButton';

/**
 * The custom room, the way a player needs it at the start: "ID ___ / Password ___", each with a copy button. Before the
 * host posts it, the same card with empty lines and a note that they'll be told. The server sends `room` only to who
 * may see it (the host, registered players, anyone on a live event); this card is shown only to them.
 */
export function RoomCard({ tournament: tn }: { tournament: Tournament }) {
  const t = useT();
  const room = tn.room;
  return (
    <View style={[styles.card, room ? styles.cardReady : styles.cardWaiting]} testID="room-card">
      <View style={styles.head}>
        <View style={[styles.icon, room && styles.iconReady]}>
          <FeatherIcon name="key" size={16} color={room ? colors.text : colors.limeDark} />
        </View>
        <Text style={styles.title}>{t('tournament.room.title')}</Text>
        {room?.updatedAt ? <Text style={styles.updated}>{t('tournament.room.updated', { time: formatDateTime(room.updatedAt) })}</Text> : null}
      </View>

      <Line label={t('tournament.room.id')} value={room?.roomId ?? null} copyLabel={t('tournament.room.copyId')} />
      <View style={styles.divider} />
      <Line
        label={t('tournament.room.password')}
        value={room ? room.password : null}
        empty={room && !room.password ? t('tournament.room.noPassword') : null}
        copyLabel={t('tournament.room.copyPassword')}
      />

      <Text style={styles.note}>{room ? t('tournament.room.hint') : t('tournament.room.waiting')}</Text>
    </View>
  );
}

/** One "label / value [copy]" line. `value` null + no `empty` text = not posted yet (a blank line to fill). */
function Line({ label, value, empty, copyLabel }: { label: string; value: string | null; empty?: string | null; copyLabel: string }) {
  return (
    <View style={styles.line}>
      <View style={styles.lineText}>
        <Text style={styles.label}>{label}</Text>
        {value ? (
          <Text style={styles.value} selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {value}
          </Text>
        ) : empty ? (
          <Text style={styles.empty}>{empty}</Text>
        ) : (
          <View style={styles.blank} accessibilityLabel="—" />
        )}
      </View>
      {value ? <CopyButton value={value} accessibilityLabel={copyLabel} variant="label" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, gap: spacing.sm + 2 },
  cardReady: { backgroundColor: colors.limeSoft, borderWidth: 1, borderColor: '#CDEBA0' },
  cardWaiting: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong, borderStyle: 'dashed' },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  iconReady: { backgroundColor: colors.lime },
  title: { flex: 1, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  updated: { fontFamily: fonts.medium, fontSize: 12, color: colors.textMuted },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52 },
  lineText: { flex: 1, minWidth: 0 },
  label: { fontFamily: fonts.semibold, fontSize: 12, letterSpacing: 0.4, textTransform: 'uppercase', color: colors.textMuted },
  value: { marginTop: 2, fontFamily: fonts.extrabold, fontSize: 22, letterSpacing: 0.5, color: colors.text },
  empty: { marginTop: 4, fontFamily: fonts.semibold, fontSize: 15, color: colors.textMuted },
  blank: { marginTop: 14, height: 2, width: '70%', borderRadius: 1, backgroundColor: colors.borderStrong },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderStrong },
  note: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
});
