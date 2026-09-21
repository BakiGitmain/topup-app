import { Image } from 'expo-image';
import { IconButton } from '../ui/IconButton';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PickedArtwork } from '../../lib/artwork';
import { ART_MAX_SIDE } from '../../lib/artworkSize';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  picked: PickedArtwork | null;
  onPick: () => void;
  onRemove: () => void;
  disabled?: boolean;
  error?: string | null;
};

/** Optional product artwork. Without it the shop shows the product's letter tile. */
export function ArtworkPicker({ picked, onPick, onRemove, disabled = false, error }: Props) {
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.preview}>
          {picked ? (
            <Image source={{ uri: picked.uri }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityLabel="Chosen artwork" />
          ) : (
            <FeatherIcon name="package" size={28} color={colors.textFaint} />
          )}
        </View>
        <View style={styles.actions}>
          <Pressable
            onPress={onPick}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={picked ? 'Change artwork' : 'Choose artwork'}
            style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
          >
            <Text style={styles.buttonText}>{picked ? 'Change image' : 'Choose image'}</Text>
          </Pressable>
          {picked && (
            <IconButton icon="trash-2" label="Remove artwork" onPress={onRemove} disabled={disabled} tone="danger" size={40} />
          )}
        </View>
      </View>
      <Text style={styles.hint}>
        Optional. You crop it to a square, then it is shrunk to at most {ART_MAX_SIDE}px and saved as a JPEG when you save the product.
      </Text>
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  preview: {
    width: 84,
    height: 84,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flex: 1, alignItems: 'flex-start', gap: spacing.xs },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.lime },
  buttonText: { fontFamily: fonts.bold, fontSize: 14, color: colors.primary },
  remove: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  removeText: { fontFamily: fonts.bold, fontSize: 14, color: colors.danger },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
  hint: { marginTop: spacing.sm, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  error: { marginTop: spacing.xs, fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.danger },
});
