import { Pressable, StyleSheet } from 'react-native';

import { pasteFromClipboard } from '../../lib/clipboard';
import { useT } from '../../lib/i18n';
import { colors, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

/**
 * A paste icon for the inside of a text field (`TextField right={...}`). Tap reads the clipboard and REPLACES the
 * field's content with it, as-is: no trimming, no checking. An empty or unreadable clipboard does nothing.
 */
export function PasteButton({ onPaste }: { onPaste: (text: string) => void }) {
  const t = useT();
  return (
    <Pressable
      onPress={async () => {
        const text = await pasteFromClipboard();
        if (text !== null) onPaste(text);
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t('product.paste')}
      style={({ pressed }) => [styles.paste, pressed && { opacity: 0.6 }]}
    >
      <FeatherIcon name="clipboard" size={20} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  paste: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -spacing.sm },
});
