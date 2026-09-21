import { Image } from 'expo-image';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import type { TutorialImage } from '../../lib/paymentTutorials';
import { colors, fonts, radius, spacing } from '../../lib/theme';

const HEIGHT = 300;

/**
 * The admin's "how to pay" pictures for the chosen payment method: a swipeable carousel, one picture per page, with dots
 * showing where you are. Draws NOTHING when there are no pictures (no empty box, no heading). Each picture is shown whole
 * (contained), so a screenshot's text is never cropped. Give it a `key` of the provider so switching starts at the first picture.
 */
export function TutorialCarousel({ images }: { images: readonly TutorialImage[] }) {
  const t = useT();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);

  if (images.length === 0) return null;

  return (
    <View style={styles.wrap} onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}>
      <Text style={styles.title} accessibilityRole="header">
        {t('pay.tutorial')}
      </Text>
      {width > 0 && (
        <View style={styles.frame}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            decelerationRate="fast"
            onMomentumScrollEnd={(e) => setIndex(Math.max(0, Math.min(images.length - 1, Math.round(e.nativeEvent.contentOffset.x / width))))}
            accessibilityLabel={t('pay.tutorial')}
          >
            {images.map((image, i) => (
              <View key={image.id} style={{ width, height: HEIGHT }}>
                <Image
                  source={{ uri: image.url }}
                  style={StyleSheet.absoluteFill}
                  contentFit="contain"
                  transition={150}
                  accessibilityLabel={t('pay.tutorialImage', { n: i + 1, total: images.length })}
                />
              </View>
            ))}
          </ScrollView>
        </View>
      )}
      {images.length > 1 && (
        <View style={styles.dots} accessible accessibilityLabel={t('pay.tutorialImage', { n: index + 1, total: images.length })}>
          {images.map((image, i) => (
            <View key={image.id} style={[styles.dot, i === index && styles.dotOn]} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.md },
  title: { marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  frame: { borderRadius: radius.lg - 4, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dots: { flexDirection: 'row', alignSelf: 'center', gap: 6, marginTop: spacing.sm },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.borderStrong },
  dotOn: { width: 20, backgroundColor: colors.limeDeep },
});
