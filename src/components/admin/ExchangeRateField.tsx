import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/ErrorBanner';
import { TextField } from '../ui/TextField';

type Props = {
  /** What is typed, and the rate saved in the database (null while unknown). */
  rateText: string;
  savedRate: number | null;
  rateValid: boolean;
  /** The saved rate could not be read: the admin can type one, or try again. */
  unreadable: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onRetry: () => void;
  saving: boolean;
  error: string | null;
  /** The result of the last recalculation ("Updated 5 prices. 2 you typed were kept."). */
  note: string | null;
  disabled?: boolean;
};

/**
 * The ONE shared exchange rate (birr per US dollar). Typing it recalculates the packs that have no typed price, each at its own
 * markup; "Save rate" keeps it for next time (only admins can change it).
 */
export function ExchangeRateField(p: Props) {
  const changed = p.savedRate !== null && p.rateValid && Number(p.rateText.replace(/,/g, '')) !== p.savedRate;
  return (
    <View style={styles.wrap}>
      {p.unreadable && (
        <View style={styles.gap}>
          <ErrorBanner message="Couldn't read the saved exchange rate, so prices aren't filled in. Type a rate below, or try again." />
          <Button label="Try again" variant="outline" onPress={p.onRetry} />
        </View>
      )}
      <TextField
        label="Birr per US dollar (shared by every pack)"
        value={p.rateText}
        onChangeText={p.onChange}
        keyboardType="decimal-pad"
        inputMode="decimal"
        maxLength={12}
        editable={!p.disabled}
        error={p.rateText.trim() !== '' && !p.rateValid ? 'Enter a number above 0, for example 175.' : null}
      />
      <View style={styles.row}>
        <Text style={styles.small}>
          {p.savedRate === null ? 'No rate saved yet.' : changed ? `Saved rate: ${p.savedRate}. What is typed is not saved yet.` : `Saved rate: ${p.savedRate}.`}
        </Text>
        <Button
          label="Save rate"
          variant="outline"
          onPress={p.onSave}
          loading={p.saving}
          disabled={!p.rateValid || (!changed && p.savedRate !== null) || p.disabled}
        />
      </View>
      {p.error && <ErrorBanner message={p.error} />}
      {p.note && <Text style={styles.note} accessibilityRole="alert">{p.note}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  gap: { gap: spacing.sm, marginBottom: spacing.sm },
  row: { gap: spacing.sm },
  small: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  note: { marginTop: spacing.sm, fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 18, color: colors.limeInk },
});
