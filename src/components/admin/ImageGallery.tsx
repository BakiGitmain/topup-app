import { Image } from 'expo-image';
import { IconButton } from '../ui/IconButton';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

export type GalleryItem = { key: string; uri: string };

type Props = {
  items: readonly GalleryItem[];
  onAdd: () => void;
  onRemove: (key: string) => void;
  /** Something is being uploaded or removed: block further taps. */
  busy?: boolean;
  max: number;
  error?: string | null;
  /** Shown when there are no images yet. */
  emptyText: string;
};

/** A product's card images: thumbnails with a Remove under each, and an Add button. */
export function ImageGallery({ items, onAdd, onRemove, busy = false, max, error, emptyText }: Props) {
  const full = items.length >= max;
  return (
    <View>
      {items.length === 0 && <Text style={styles.empty}>{emptyText}</Text>}
      <View style={styles.grid}>
        {items.map((item, i) => (
          <View key={item.key} style={styles.cell}>
            <View style={styles.thumb}>
              <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityLabel={`Image ${i + 1}`} accessibilityIgnoresInvertColors />
            </View>
            <IconButton icon="trash-2" label={`Remove image ${i + 1}`} onPress={() => onRemove(item.key)} disabled={busy} tone="danger" size={36} />
          </View>
        ))}

        {!full && (
          <Pressable
            onPress={onAdd}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Add image"
            style={({ pressed }) => [styles.add, pressed && styles.pressed, busy && styles.disabled]}
          >
            {busy ? <ActivityIndicator color={colors.limeDeep} /> : <FeatherIcon name="plus" size={24} color={colors.limeInk} strokeWidth={2.4} />}
            <Text style={styles.addText}>{busy ? 'Working' : 'Add image'}</Text>
          </Pressable>
        )}
      </View>
      {full && <Text style={styles.hint}>{`That's the most a product can have (${max}). Remove one to add another.`}</Text>}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

const SIZE = 84;

const styles = StyleSheet.create({
  empty: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted, marginBottom: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + 4 },
  cell: { width: SIZE, alignItems: 'center' },
  thumb: { width: SIZE, height: SIZE, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  remove: { minHeight: 44, minWidth: SIZE, alignItems: 'center', justifyContent: 'center' },
  removeText: { fontFamily: fonts.bold, fontSize: 13, color: colors.danger },
  add: {
    width: SIZE,
    height: SIZE,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.limeDeep,
    backgroundColor: colors.limeSoft,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  addText: { fontFamily: fonts.bold, fontSize: 12, color: colors.limeDark },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
  hint: { marginTop: spacing.xs, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  error: { marginTop: spacing.xs, fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.danger },
});
