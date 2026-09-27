import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { Avatar } from '../../components/market/Avatar';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { TextField } from '../../components/ui/TextField';
import { useAuth } from '../../lib/auth';
import { isValidDisplayName } from '../../lib/accountLogic';
import { pickAvatar, saveAvatar } from '../../lib/avatar';
import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';

const AVATAR_SIZE = 96;

/** Display name and profile picture. Tap the picture to pick, crop and upload a new one. */
export default function EditProfileScreen() {
  const { user, session, profile, initializing, completeUsername, refreshAccount } = useAuth();
  const t = useT();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  // null = untouched, so the field follows the profile until the user types (the profile may still be loading).
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const current = profile?.display_name ?? '';
  const name = draft ?? current;
  const valid = isValidDisplayName(name);
  const changed = name.trim() !== current;

  async function changePhoto() {
    if (!user || uploading) return;
    setError(null);
    const picked = await pickAvatar();
    if (!picked) return;
    setUploading(true);
    try {
      await saveAvatar(user.id, picked);
      await refreshAccount();
      toast(t('editProfile.photoSaved'));
    } catch {
      setError(t('editProfile.photoFailed'));
    } finally {
      setUploading(false);
    }
  }

  async function saveName() {
    if (!valid || !changed || saving) return;
    setError(null);
    setSaving(true);
    try {
      // The same server-validated call the choose-username step uses (trimmed, 2-40 characters).
      await completeUsername(name);
      setDraft(null);
      toast(t('editProfile.saved'));
    } catch {
      setError(t('username.failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled">
        <Column>
          <ScreenHeader title={t('settings.editProfile')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/profile'))} />

          <View style={styles.avatarBlock}>
            <Pressable
              onPress={changePhoto}
              disabled={uploading}
              accessibilityRole="button"
              accessibilityLabel={t('editProfile.changePhoto')}
              accessibilityState={{ busy: uploading }}
            >
              <Avatar name={current} uri={profile?.avatar_url} size={AVATAR_SIZE} />
              {uploading && (
                <View style={styles.uploading}>
                  <ActivityIndicator color={colors.primaryText} />
                </View>
              )}
              <View style={styles.cameraBadge}>
                <FeatherIcon name="camera" size={16} color={colors.primaryText} />
              </View>
            </Pressable>
            <Pressable onPress={changePhoto} disabled={uploading} hitSlop={8}>
              <Text style={styles.changePhoto}>{t('editProfile.changePhoto')}</Text>
            </Pressable>
          </View>

          {error ? <ErrorBanner message={error} /> : null}

          <TextField
            label={t('editProfile.name')}
            value={name}
            onChangeText={setDraft}
            placeholder={t('username.placeholder')}
            autoCapitalize="words"
            maxLength={40}
            returnKeyType="done"
            onSubmitEditing={saveName}
            error={name.trim().length > 0 && !valid ? t('editProfile.nameInvalid') : null}
          />
          <Button label={t('editProfile.save')} onPress={saveName} loading={saving} disabled={!valid || !changed} />
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  avatarBlock: { alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.lg },
  uploading: {
    ...StyleSheet.absoluteFill,
    borderRadius: AVATAR_SIZE / 2,
    backgroundColor: 'rgba(20,26,18,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderWidth: 3,
    borderColor: colors.bg,
  },
  changePhoto: { fontFamily: fonts.semibold, fontSize: 14, color: colors.limeInk },
});
