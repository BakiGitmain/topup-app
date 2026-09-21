import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../../lib/theme';

type Props = {
  name?: string | null;
  uri?: string | null;
  size?: number;
};

export function Avatar({ name, uri, size = 44 }: Props) {
  const initial = (name?.trim()[0] ?? '?').toUpperCase();
  const box = { width: size, height: size, borderRadius: size / 2 };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.base, box]}
        contentFit="cover"
        accessibilityLabel={name ? `${name}'s photo` : 'Profile photo'}
      />
    );
  }

  return (
    <View style={[styles.base, styles.fallback, box]}>
      <Text style={[styles.initial, { fontSize: size * 0.42 }]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: colors.limeSoft },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  initial: { fontFamily: fonts.extrabold, color: colors.limeInk },
});
