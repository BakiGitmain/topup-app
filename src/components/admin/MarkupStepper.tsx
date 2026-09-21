import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { parsePercent } from '../../lib/priceCalc';
import { colors, fonts, radius } from '../../lib/theme';
import { IconButton } from '../ui/IconButton';

type Props = {
  /** This pack's markup in percent. */
  percent: number;
  onPercent: (percent: number) => void;
  onStep: (direction: 1 | -1) => void;
  /** Names the pack for screen readers ("Markup for 100 Diamonds"). */
  packName: string;
  disabled?: boolean;
};

/** A - [percent] + control for ONE pack's markup. Typing is free; a value that isn't a number in range is shown in red and not used. */
export function MarkupStepper({ percent, onPercent, onStep, packName, disabled }: Props) {
  // While typing, the box shows what was typed ("-", "2."); otherwise it shows the pack's percent, so a press of + or - is visible at once.
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? String(percent);
  const invalid = typed !== null && parsePercent(typed) === null;

  return (
    <View style={styles.row} accessibilityLabel={`Markup for ${packName}`}>
      <IconButton
        icon="minus"
        label={`Lower the markup for ${packName} by 1 percent`}
        onPress={() => {
          setTyped(null);
          onStep(-1);
        }}
        disabled={disabled}
        size={44}
      />
      <View style={[styles.box, invalid && styles.boxBad]}>
        <TextInput
          value={shown}
          onChangeText={(text) => {
            setTyped(text);
            const value = parsePercent(text);
            if (value !== null) onPercent(value);
          }}
          onBlur={() => setTyped(null)}
          keyboardType="numbers-and-punctuation"
          inputMode="decimal"
          maxLength={7}
          editable={!disabled}
          accessibilityLabel={`Markup in percent for ${packName}`}
          style={styles.input}
        />
        <Text style={styles.sign}>%</Text>
      </View>
      <IconButton
        icon="plus"
        label={`Raise the markup for ${packName} by 1 percent`}
        onPress={() => {
          setTyped(null);
          onStep(1);
        }}
        disabled={disabled}
        size={44}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 78,
    height: 44,
    paddingHorizontal: 8,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  boxBad: { borderColor: colors.danger },
  input: { flex: 1, height: '100%', textAlign: 'center', fontFamily: fonts.semibold, fontSize: 15, color: colors.text, padding: 0 },
  sign: { fontFamily: fonts.bold, fontSize: 13, color: colors.textMuted },
});
