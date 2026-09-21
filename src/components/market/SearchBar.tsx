import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';
import { CloseIcon, SearchIcon } from '../art/Icons';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  /** Pressing Search / Enter on the keyboard: search right now, without waiting for a pause in typing. */
  onSubmit?: () => void;
};

export function SearchBar({ value, onChangeText, placeholder = 'Search', onSubmit }: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[styles.box, focused && styles.boxFocused]}>
      <SearchIcon size={19} color={colors.textMuted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={placeholder}
      />
      {value.length > 0 && (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          style={styles.clear}
        >
          <CloseIcon size={12} color={colors.bg} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  boxFocused: {
    borderColor: colors.limeDeep,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    height: '100%',
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
  clear: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
