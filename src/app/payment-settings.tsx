import { Image } from 'expo-image';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProviderMark } from '../components/pay/ProviderPicker';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { IconButton } from '../components/ui/IconButton';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { useAuth } from '../lib/auth';
import { pickImageUncropped, prepareArtwork, removeArtworkPaths, uploadArtwork, type PickedArtwork } from '../lib/artwork';
import { fetchTutorials, saveTutorials, tutorialErrorText, type TutorialImage } from '../lib/paymentTutorials';
import type { ProviderId } from '../lib/paymentView';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useToast } from '../lib/toast';
import { MAX_TUTORIALS, canAddMore, forProvider, isDirty, moveItem, removeItem, toSaveItems } from '../lib/tutorialEdit';
import { useAsync } from '../lib/useAsync';

const BUCKET = 'payment-tutorials';
const FOLDER = 'tutorials';
const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: 'telebirr', name: 'Telebirr' },
  { id: 'cbe', name: 'CBE' },
];

/** One image in the list being edited. A picture just chosen (not saved yet) has no id and only a local uri. */
type Staged = { key: string; id: string | null; url: string | null; path: string | null; local: PickedArtwork | null };

const fromSaved = (image: TutorialImage): Staged => ({ key: image.id, id: image.id, url: image.url, path: image.path, local: null });

/**
 * Admin: "how to pay" pictures for each payment method. Add, reorder and remove them; nothing is saved until you tap Save
 * (one all-or-nothing save per payment method), and Discard puts everything back. Customers see a swipeable carousel of the
 * chosen method's pictures above its account details, and nothing at all for a method with no pictures. English only.
 */
export default function PaymentSettingsScreen() {
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const allowed = !initializing && !!session && isAdmin;

  const saved = useAsync(fetchTutorials, 0, allowed);
  // Edited lists, only for methods the admin has touched; the rest show what is saved.
  const [edits, setEdits] = useState<Partial<Record<ProviderId, Staged[]>>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  const savedFor = (p: ProviderId) => forProvider(saved.data ?? [], p);
  const listFor = (p: ProviderId): Staged[] => edits[p] ?? savedFor(p).map(fromSaved);
  const dirty = (p: ProviderId) => edits[p] !== undefined && isDirty(savedFor(p).map((i) => i.id), listFor(p));
  const anyDirty = PROVIDERS.some((p) => dirty(p.id));

  const change = (p: ProviderId, next: Staged[]) => {
    setEdits((current) => ({ ...current, [p]: next }));
    setMessage(null);
  };

  async function add(p: ProviderId) {
    if (busy || !canAddMore(listFor(p).length)) return;
    try {
      const picked = await pickImageUncropped();
      if (!picked) return;
      change(p, [...listFor(p), { key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, id: null, url: null, path: null, local: picked }]);
    } catch {
      setMessage("Couldn't open your photos. Check that the app may read them, then try again.");
    }
  }

  async function saveAll() {
    if (busy || !anyDirty) return;
    setBusy(true);
    setMessage(null);
    const savedProviders: ProviderId[] = [];
    try {
      for (const { id: p } of PROVIDERS) {
        if (!dirty(p)) continue;
        // 1. upload the pictures added since the last save
        const uploadedPaths: string[] = [];
        const staged: Staged[] = [];
        try {
          for (const item of listFor(p)) {
            if (item.id || item.url || !item.local) {
              staged.push(item);
              continue;
            }
            const prepared = await prepareArtwork(item.local, 1280);
            const uploaded = await uploadArtwork(prepared, BUCKET, FOLDER);
            uploadedPaths.push(uploaded.path);
            staged.push({ ...item, url: uploaded.url, path: uploaded.path });
          }
          // 2. the all-or-nothing save of this method's whole list
          const removed = await saveTutorials(p, toSaveItems(staged));
          // 3. tidy: delete the files of images that are gone
          await removeArtworkPaths(removed, BUCKET);
          savedProviders.push(p);
        } catch (err) {
          // Nothing was saved for this method: take back the files uploaded a moment ago so none are orphaned.
          await removeArtworkPaths(uploadedPaths, BUCKET);
          throw err;
        }
      }
      toast('Saved');
      setEdits((current) => {
        const next = { ...current };
        for (const p of savedProviders) delete next[p];
        return next;
      });
      await saved.reload();
    } catch (err) {
      setMessage(
        savedProviders.length > 0
          ? `${tutorialErrorText(err)} (${savedProviders.join(', ')} was saved.)`
          : tutorialErrorText(err)
      );
      if (savedProviders.length > 0) {
        setEdits((current) => {
          const next = { ...current };
          for (const p of savedProviders) delete next[p];
          return next;
        });
        await saved.reload();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 110 }} showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title="Payment settings" />
          <Text style={styles.lead}>
            Add “how to pay” pictures for each method. Customers swipe through them on the payment screen. Leave a method empty to show nothing.
          </Text>

          {saved.status === 'loading' && !saved.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}
          {saved.status === 'error' && !saved.data && <ErrorBanner message="Couldn't load the pictures. Pull back and try again." />}

          {PROVIDERS.map(({ id: p, name }) => {
            const list = listFor(p);
            return (
              <View key={p} style={styles.card}>
                <View style={styles.cardHead}>
                  <ProviderMark provider={p} height={26} />
                  <Text style={styles.cardTitle}>{name}</Text>
                  <Text style={styles.count}>
                    {list.length}/{MAX_TUTORIALS}
                  </Text>
                </View>

                {list.length === 0 && <Text style={styles.empty}>No pictures. Customers see just the account details.</Text>}

                {list.map((item, i) => (
                  <View key={item.key} style={styles.row}>
                    <View style={styles.thumb}>
                      <Image source={{ uri: item.url ?? item.local?.uri }} style={StyleSheet.absoluteFill} contentFit="contain" accessibilityIgnoresInvertColors />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle}>Picture {i + 1}</Text>
                      {item.id === null && <Text style={styles.rowNew}>New, saved when you tap Save</Text>}
                    </View>
                    <IconButton icon="arrow-up" label={`Move picture ${i + 1} up`} size={40} disabled={busy || i === 0} onPress={() => change(p, moveItem(list, i, i - 1))} />
                    <IconButton icon="arrow-down" label={`Move picture ${i + 1} down`} size={40} disabled={busy || i === list.length - 1} onPress={() => change(p, moveItem(list, i, i + 1))} />
                    <IconButton icon="trash-2" label={`Remove picture ${i + 1}`} tone="danger" size={40} disabled={busy} onPress={() => change(p, removeItem(list, i))} />
                  </View>
                ))}

                <Button
                  label={canAddMore(list.length) ? 'Add a picture' : `Limit of ${MAX_TUTORIALS} reached`}
                  variant="outline"
                  onPress={() => add(p)}
                  disabled={busy || !canAddMore(list.length)}
                  style={styles.add}
                />
              </View>
            );
          })}

          {message && <ErrorBanner message={message} />}
        </Column>
      </ScrollView>

      {/* The batch bar: one save for everything edited above. */}
      {anyDirty && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.md }]}>
          <Column>
            <View style={styles.barRow}>
              <Button label="Discard" variant="outline" onPress={() => setEdits({})} disabled={busy} style={styles.barButton} />
              <Button label="Save changes" onPress={saveAll} loading={busy} style={styles.barButton} />
            </View>
          </Column>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  lead: { marginBottom: spacing.md, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  loading: { marginTop: spacing.xl },
  card: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { flex: 1, fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  count: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted },
  empty: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  thumb: { width: 56, height: 56, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  rowNew: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12, color: colors.limeInk },
  add: { marginTop: spacing.xs },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: spacing.sm + 2, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.border },
  barRow: { flexDirection: 'row', gap: spacing.sm + 2 },
  barButton: { flex: 1 },
});
