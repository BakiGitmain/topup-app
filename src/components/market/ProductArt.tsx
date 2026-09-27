import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { tileLetter } from '../../lib/catalogRules';
import { colors, fonts, radius } from '../../lib/theme';

type Props = {
  name: string;
  imageUrl: string | null;
  /** The product's own tint, behind the letter when there is no picture. */
  tint: string | null;
  size: number;
  /** The letter's size; defaults to the shop tile's. */
  letterSize?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * A product's artwork: its picture whole in a rounded square (contained, never cropped or stretched), or, when there
 * is no picture or it fails to load, its first letter on the product's own tint. The ONE art rule for the shop tile,
 * the vault's gift and redeem-code cards, anything that shows a product small.
 */
export function ProductArt({ name, imageUrl, tint, size, letterSize, style }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = imageUrl !== null && failedUrl !== imageUrl;

  return (
    <View style={[styles.art, { width: size, height: size, backgroundColor: showImage ? colors.bg : (tint ?? colors.surface) }, style]}>
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          transition={150}
          accessibilityIgnoresInvertColors
          onError={(event) => {
            if (__DEV__) console.warn(`[artwork] failed to load for "${name}": ${imageUrl} (${event.error})`);
            setFailedUrl(imageUrl);
          }}
        />
      ) : (
        <Text style={[styles.letter, letterSize ? { fontSize: letterSize } : null]} numberOfLines={1} allowFontScaling={false} importantForAccessibility="no">
          {tileLetter(name)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  art: {
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  letter: { fontFamily: fonts.extrabold, fontSize: 26, color: colors.text, opacity: 0.5, includeFontPadding: false },
});
