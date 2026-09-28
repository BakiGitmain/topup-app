import { LinearGradient } from 'expo-linear-gradient';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon, type FeatherName } from '../../components/art/FeatherIcon';
import { Avatar } from '../../components/market/Avatar';
import { EditTournamentSheet } from '../../components/tournament/EditTournamentSheet';
import { entryLabel, formatLine, gameLabel, modeLabel, placeLabel, platformLabel, whenText } from '../../components/tournament/labels';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { formatBirr } from '../../lib/catalog';
import { confirmDestructive } from '../../lib/confirm';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { phaseOf, serverErrorOf } from '../../lib/tournamentRules';
import { cancelTournament, fetchTournament, type TournamentReward } from '../../lib/tournaments';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { useNow } from '../../lib/useNow';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TournamentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, initializing } = useAuth();
  const t = useT();
  const toast = useToast();
  const now = useNow();
  const validId = typeof id === 'string' && UUID.test(id);
  const detail = useAsync(() => fetchTournament(id!), id ?? '', !!session && validId);
  useRefreshOnFocus(detail.reload);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const tn = detail.data;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/tournaments'));

  async function onRefresh() {
    setRefreshing(true);
    await detail.reload();
    setRefreshing(false);
  }

  async function cancel() {
    if (!tn || cancelling) return;
    const sure = await confirmDestructive(t('tournament.detail.cancelTitle'), t('tournament.detail.cancelBody'), t('tournament.detail.cancelConfirm'));
    if (!sure) return;
    setCancelling(true);
    try {
      await cancelTournament(tn.id);
      toast(t('tournament.detail.cancelled'));
      await detail.reload();
    } catch (e) {
      const code = serverErrorOf(e);
      toast(code === 'tournament_closed' ? t('tournament.err.tournament_closed') : t('tournament.err.generic'));
      await detail.reload();
    } finally {
      setCancelling(false);
    }
  }

  if (!validId || (detail.status === 'ready' && !tn)) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Column>
          <ScreenHeader title={t('tournament.title')} onBack={back} />
          <Text style={styles.muted}>{t('tournament.detail.notFound')}</Text>
        </Column>
      </SafeAreaView>
    );
  }

  const phase = tn ? phaseOf(tn.status, tn.startsAt, now) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.limeInk} />}
      >
        <Column>
          <ScreenHeader title={tn ? gameLabel(t, tn.game) : t('tournament.title')} onBack={back} />
          {detail.status === 'error' && <ErrorBanner message={t('common.loadError')} />}
          {!tn ? (
            detail.status === 'error' ? (
              <Button label={t('common.retry')} variant="outline" onPress={detail.reload} />
            ) : (
              <ActivityIndicator color={colors.limeInk} style={styles.loading} />
            )
          ) : (
            <>
              <LinearGradient colors={['#F8FDEF', '#E1F5BC']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
                <View style={styles.heroTop}>
                  <View style={[styles.badge, tn.kind === 'live' && styles.badgeLive]}>
                    <FeatherIcon name={tn.kind === 'live' ? 'radio' : 'users'} size={13} color={tn.kind === 'live' ? colors.danger : colors.limeDark} />
                    <Text style={[styles.badgeText, tn.kind === 'live' && styles.badgeTextLive]}>{t(`tournament.kind.${tn.kind}`)}</Text>
                  </View>
                  <Text style={[styles.when, phase === 'started' && styles.whenLive]}>{whenText(t, tn.status, tn.startsAt, now)}</Text>
                </View>
                <Text style={styles.heroGame}>
                  {gameLabel(t, tn.game)} · {modeLabel(t, tn.mode)}
                </Text>
                <Text style={styles.heroName}>{tn.name}</Text>
              </LinearGradient>

              <View style={styles.info}>
                <InfoRow icon="calendar" label={t('tournament.detail.starts')} value={formatDateTime(tn.startsAt)} />
                <InfoRow
                  icon="users"
                  label={t('tournament.detail.format')}
                  value={formatLine(t, tn.teamSize, tn.teamCount)}
                  sub={tn.teamCount !== null && tn.teamSize > 1 ? t('tournament.players', { n: tn.teamSize * tn.teamCount }) : undefined}
                />
                {tn.kind === 'register' && <InfoRow icon="tag" label={t('tournament.detail.entry')} value={entryLabel(t, tn.entryFee)} />}
                <View style={styles.row}>
                  <Avatar name={tn.host.name} uri={tn.host.avatarUrl} size={34} />
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>{t('tournament.detail.host')}</Text>
                    <Text style={styles.rowValue} numberOfLines={1}>
                      {tn.host.name}
                    </Text>
                  </View>
                </View>
                {tn.streamUrl && (
                  <Pressable
                    onPress={() => Linking.openURL(tn.streamUrl!).catch(() => toast(t('common.loadError')))}
                    accessibilityRole="link"
                    accessibilityLabel={`${t('tournament.detail.watch')}: ${platformLabel(t, tn.streamPlatform)}`}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <View style={styles.rowIcon}>
                      <FeatherIcon name="video" size={17} color={colors.limeDark} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowLabel}>{t('tournament.detail.watch')}</Text>
                      <Text style={styles.rowValue} numberOfLines={1}>
                        {platformLabel(t, tn.streamPlatform)}
                      </Text>
                    </View>
                    <View style={styles.open}>
                      <Text style={styles.openText}>{t('tournament.detail.openStream')}</Text>
                      <FeatherIcon name="external-link" size={14} color={colors.text} />
                    </View>
                  </Pressable>
                )}
              </View>

              {tn.kind === 'live' && <Text style={styles.note}>{t('tournament.detail.liveNote')}</Text>}

              <Text style={styles.section}>{t('tournament.detail.rewards')}</Text>
              <View style={styles.places}>
                {groupByPlace(tn.rewards ?? []).map(({ place, rewards }) => (
                  <View key={place} style={styles.place}>
                    <View style={styles.placeHead}>
                      <View style={[styles.medal, place === 1 && styles.medalGold]}>
                        <Text style={styles.medalText}>{place}</Text>
                      </View>
                      <Text style={styles.placeTitle}>{placeLabel(t, place)}</Text>
                    </View>
                    {allSame(rewards) && rewards.length > 1 ? (
                      <RewardLine label={t('tournament.detail.everyPlayer')} reward={rewards[0]} />
                    ) : (
                      rewards.map((r) => <RewardLine key={r.slot} label={tn.teamSize === 1 ? '' : t('tournament.detail.player', { n: r.slot })} reward={r} />)
                    )}
                  </View>
                ))}
              </View>
              <Text style={styles.note}>{t('tournament.detail.rewardsNote')}</Text>

              {tn.isHost && phase === 'upcoming' && (
                <View style={styles.hostBox}>
                  <Text style={styles.hostTitle}>{t('tournament.detail.youHost')}</Text>
                  <Button label={t('tournament.detail.edit')} icon="edit-2" variant="outline" onPress={() => setEditing(true)} />
                  <Pressable
                    onPress={cancel}
                    disabled={cancelling}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
                  >
                    {cancelling ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.cancelText}>{t('tournament.detail.cancel')}</Text>}
                  </Pressable>
                </View>
              )}
            </>
          )}
        </Column>
      </ScrollView>
      {tn && tn.isHost && (
        <EditTournamentSheet
          visible={editing}
          tournament={tn}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast(t('tournament.detail.saved'));
            detail.reload();
          }}
        />
      )}
    </SafeAreaView>
  );
}

function groupByPlace(rewards: TournamentReward[]) {
  const places = new Map<number, TournamentReward[]>();
  for (const r of rewards) places.set(r.place, [...(places.get(r.place) ?? []), r]);
  return [...places.entries()].sort((a, b) => a[0] - b[0]).map(([place, list]) => ({ place, rewards: list.sort((a, b) => a.slot - b.slot) }));
}

const rewardKey = (r: TournamentReward) => `${r.kind}|${r.amount}|${r.productName}|${r.optionLabel}|${r.regionLabel}`;
function allSame(rewards: TournamentReward[]) {
  return rewards.every((r) => rewardKey(r) === rewardKey(rewards[0]));
}

function RewardLine({ label, reward }: { label: string; reward: TournamentReward }) {
  const money = reward.kind === 'money';
  return (
    <View style={styles.reward}>
      <FeatherIcon name={money ? 'dollar-sign' : 'gift'} size={15} color={colors.limeInk} />
      {label ? (
        <Text style={styles.rewardLabel} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
      <Text style={styles.rewardValue} numberOfLines={2}>
        {money
          ? formatBirr(reward.amount)
          : `${reward.productName} · ${reward.optionLabel}${reward.regionLabel ? ` (${reward.regionLabel})` : ''}`}
      </Text>
    </View>
  );
}

function InfoRow({ icon, label, value, sub }: { icon: FeatherName; label: string; value: string; sub?: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <FeatherIcon name={icon} size={17} color={colors.limeDark} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xxl },
  loading: { marginTop: spacing.xl },
  muted: { fontFamily: fonts.regular, fontSize: 15, color: colors.textMuted },

  hero: { padding: spacing.lg, borderRadius: radius.xl - 4, borderWidth: 1, borderColor: '#D3EFA6', marginBottom: spacing.md },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.md },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.bg },
  badgeLive: { backgroundColor: colors.dangerBg },
  badgeText: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.limeDark },
  badgeTextLive: { color: colors.danger },
  when: { fontFamily: fonts.bold, fontSize: 13, color: colors.limeDark },
  whenLive: { color: colors.danger },
  heroGame: { fontFamily: fonts.semibold, fontSize: 13.5, color: '#6E7F62' },
  heroName: { marginTop: 2, fontFamily: fonts.extrabold, fontSize: 26, lineHeight: 32, color: colors.text, letterSpacing: -0.6 },

  info: { borderRadius: radius.lg, backgroundColor: colors.surface, paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md - 2, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  pressed: { backgroundColor: colors.border },
  rowIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  rowValue: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  rowSub: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  open: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 32, borderRadius: radius.pill, backgroundColor: colors.lime },
  openText: { fontFamily: fonts.bold, fontSize: 13, color: colors.text },

  note: { marginTop: spacing.sm + 2, fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  section: { marginTop: spacing.lg, marginBottom: spacing.sm + 4, fontFamily: fonts.bold, fontSize: 17, color: colors.text, letterSpacing: -0.3 },
  places: { gap: spacing.sm + 2 },
  place: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface, gap: spacing.sm },
  placeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  medal: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border },
  medalGold: { backgroundColor: colors.lime },
  medalText: { fontFamily: fonts.extrabold, fontSize: 13, color: colors.text },
  placeTitle: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  reward: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rewardLabel: { width: 96, fontFamily: fonts.medium, fontSize: 13.5, color: colors.textMuted },
  rewardValue: { flex: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.text },

  hostBox: { marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, gap: spacing.sm + 2 },
  hostTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  cancel: { height: 48, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontFamily: fonts.bold, fontSize: 15, color: colors.danger },
});
