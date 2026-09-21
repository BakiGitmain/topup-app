import { useState } from 'react';
import { IconButton } from '../ui/IconButton';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';

export type CategoryItem = { id: string; label: string };

type Props = {
  items: readonly CategoryItem[];
  /** Resolves true when the category was added (so the box can clear). */
  onAdd: (label: string) => Promise<boolean> | boolean;
  onRemove: (id: string) => void;
  /** When given, each name can be edited in place and is saved on "Save name". */
  onRename?: (id: string, label: string) => Promise<boolean> | boolean;
  busy?: boolean;
  error?: string | null;
  max: number;
};

/** A product's categories ("UC", "Coins", "Membership"): add, rename (optional) and remove. */
export function CategoriesEditor({ items, onAdd, onRemove, onRename, busy = false, error, max }: Props) {
  const [text, setText] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const full = items.length >= max;

  async function add() {
    const label = text.trim();
    if (label === '' || busy) return;
    if (await onAdd(label)) setText('');
  }

  return (
    <View>
      {items.length === 0 && (
        <Text style={styles.hint}>
          {'Optional. With two or more categories, customers see a pill for each above "Choose an amount" and every pack must be in one.'}
        </Text>
      )}

      {items.map((item) => {
        const edited = names[item.id];
        const changed = onRename !== undefined && edited !== undefined && edited.trim() !== item.label;
        return (
          <View key={item.id} style={styles.row}>
            {onRename ? (
              <TextInput
                value={edited ?? item.label}
                onChangeText={(v) => setNames((n) => ({ ...n, [item.id]: v }))}
                editable={!busy}
                maxLength={40}
                accessibilityLabel={`Name of category ${item.label}`}
                style={styles.input}
              />
            ) : (
              <Text style={styles.name} numberOfLines={1}>
                {item.label}
              </Text>
            )}
            {changed && (
              <Pressable
                onPress={async () => {
                  if (await onRename?.(item.id, (edited ?? '').trim())) setNames((n) => { const { [item.id]: _drop, ...rest } = n; return rest; });
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Save name for category ${item.label}`}
                style={styles.action}
              >
                <Text style={styles.actionText}>Save name</Text>
              </Pressable>
            )}
            <IconButton icon="trash-2" label={`Remove category ${item.label}`} onPress={() => onRemove(item.id)} disabled={busy} tone="danger" size={36} />
          </View>
        );
      })}

      {!full && (
        <View style={styles.addRow}>
          <TextInput
            value={text}
            onChangeText={setText}
            onSubmitEditing={add}
            editable={!busy}
            maxLength={40}
            placeholder="New category, for example UC"
            placeholderTextColor={colors.textFaint}
            accessibilityLabel="New category name"
            returnKeyType="done"
            style={[styles.input, styles.addInput]}
          />
          <Pressable
            onPress={add}
            disabled={busy || text.trim() === ''}
            accessibilityRole="button"
            accessibilityLabel="Add category"
            style={({ pressed }) => [styles.addButton, (busy || text.trim() === '') && styles.disabled, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>
      )}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  input: {
    flex: 1,
    height: 46,
    paddingHorizontal: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
  actionText: { fontFamily: fonts.bold, fontSize: 13, color: colors.limeInk },
  removeText: { fontFamily: fonts.bold, fontSize: 13, color: colors.danger },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  addInput: { minWidth: 0 },
  addButton: { minHeight: 46, paddingHorizontal: spacing.md + 4, borderRadius: radius.pill, backgroundColor: colors.lime, justifyContent: 'center' },
  addText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.primary },
  disabled: { opacity: 0.5 },
  error: { marginTop: spacing.xs, fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.danger },
});
