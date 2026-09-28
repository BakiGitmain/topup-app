import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../../components/art/FeatherIcon';
import { placeLabel } from '../../../components/tournament/labels';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../../components/ui/ScreenHeader';
import { Column } from '../../../components/ui/TabScroll';
import { useAuth } from '../../../lib/auth';
import { formatBirr } from '../../../lib/catalog';
import { confirmDestructive } from '../../../lib/confirm';
import { useT } from '../../../lib/i18n';
import type { StringKey } from '../../../lib/strings';
import { colors, fonts, radius, spacing } from '../../../lib/theme';
import { useToast } from '../../../lib/toast';
import {
  PLATFORM_CUT_PERCENT,
  finishPreview,
  phaseOf,
  pickTeam,
  placementsOf,
  placesToPick,
  serverErrorOf,
  type Picks,
} from '../../../lib/tournamentRules';
import { fetchTournament, finishTournament, type TournamentReward } from '../../../lib/tournaments';
import { useAsync } from '../../../lib/useAsync';
import { useNow } from '../../../lib/useNow';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The host of a register tournament picks the team that took each rewarded place, sees what will be paid, and ends it.
 * Everything is paid by the server in one step (tournament_finish); this screen only collects the places. A team can
 * hold one place; a place with no team possible (fewer teams than places) isn't asked.
 */
export default function FinishTournamentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, initializing } = useAuth();
  const t = useT();
  const toast = useToast();
  const now = useNow();
  const validId = typeof id === 'string' && UUID.test(id);
  const detail = useAsync(() => fetchTournament(id!), id ?? '', !!session && validId);
  const [picks, setPicks] = useState<Picks>({});
  const [error, setError] = useState<StringKey | null>(null);
  const [saving, setSaving] = useState(false);
  const working = useRef(false);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/tournament/[id]', params: { id: id ?? '' } }));

  const tn = detail.data;
  if (!validId || (detail.status === 'ready' && (!tn || !tn.isHost || tn.kind !== 'register'))) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Column>
          <ScreenHeader title={t('tournament.finish.title')} onBack={back} />
          <Text style={styles.muted}>{t('tournament.detail.notFound')}</Text>
        </Column>
      </SafeAreaView>
    );
  }
  if (!tn) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Column>
          <ScreenHeader title={t('tournament.finish.title')} onBack={back} />
          {detail.status === 'error' ? (
            <>
              <ErrorBanner message={t('common.loadError')} />
              <Button label={t('common.retry')} variant="outline" onPress={detail.reload} />
            </>
          ) : (
            <ActivityIndicator color={colors.limeInk} style={styles.loading} />
          )}
        </Column>
      </SafeAreaView>
    );
  }

  const phase = phaseOf(tn.status, tn.startsAt, now);
  const teams = tn.teams ?? [];
  const rewards = tn.rewards ?? [];
  const need = placesToPick(tn.places, teams.length);
  const placements = placementsOf(picks, need);
  const fees = teams.reduce((sum, team) => sum + team.feePaid, 0);
  const preview = finishPreview(rewards, need, fees);
  const byPlace = (place: number) => rewards.filter((r) => r.place === place).sort((a, b) => a.slot - b.slot);
  const placeOf = (teamId: string) => Number(Object.entries(picks).find(([, v]) => v === teamId)?.[0] ?? 0) || null;

  async function finish() {
    if (working.current || !tn) return;
    if (!placements) return setError('tournament.finish.pickAll');
    const sure = await confirmDestructive(t('tournament.finish.confirmTitle'), t('tournament.finish.confirmBody'), t('tournament.finish.confirm'), 'primary');
    if (!sure) return;
    working.current = true;
    setError(null);
    setSaving(true);
    try {
      await finishTournament(tn.id, placements);
      toast(t('tournament.finish.done'));
      back();
    } catch (e) {
      const code = serverErrorOf(e);
      const map: Record<string, StringKey> = {
        invalid_placements: 'tournament.finish.err.invalid_placements',
        not_started: 'tournament.finish.err.not_started',
        tournament_closed: 'tournament.err.tournament_closed',
      };
      setError((code && map[code]) || 'tournament.err.generic');
      // The teams or the state may have moved: read it again (the picks stay, the server re-checks them).
      detail.reload();
    } finally {
      working.current = false;
      setSaving(false);
    }
  }

  const ready = tn.status === 'published' && phase === 'started';
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Column>
          <ScreenHeader title={t('tournament.finish.title')} onBack={back} />
          <Text style={styles.name} numberOfLines={2}>
            {tn.name}
          </Text>
          {!ready ? (
            <Text style={styles.muted}>{tn.status === 'published' ? t('tournament.end.afterStart') : t('tournament.err.tournament_closed')}</Text>
          ) : (
            <>
              <Text style={styles.intro}>{need > 0 ? t('tournament.finish.intro') : t('tournament.finish.noTeams')}</Text>
              {error && <ErrorBanner message={t(error)} />}

              {Array.from({ length: need }, (_, i) => i + 1).map((place) => (
                <View key={place} style={styles.place}>
                  <View style={styles.placeHead}>
                    <View style={[styles.medal, place === 1 && styles.medalGold, place === 2 && styles.medalSilver, place === 3 && styles.medalBronze]}>
                      <Text style={styles.medalText}>{place}</Text>
                    </View>
                    <Text style={styles.placeTitle}>{t('tournament.finish.pickFor', { place: placeLabel(t, place) })}</Text>
                  </View>
                  <Text style={styles.rewardLine} numberOfLines={2}>
                    {t('tournament.finish.rewardLine')}: {rewardSummary(byPlace(place))}
                  </Text>
                  <View style={styles.teams}>
                    {teams.map((team) => {
                      const chosen = picks[place] === team.id;
                      const elsewhere = !chosen ? placeOf(team.id) : null;
                      return (
                        <Pressable
                          key={team.id}
                          onPress={() => {
                            setError(null);
                            setPicks((p) => pickTeam(p, place, team.id));
                          }}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: chosen }}
                          accessibilityLabel={`${placeLabel(t, place)}: ${team.name}`}
                          style={({ pressed }) => [styles.team, chosen && styles.teamChosen, pressed && styles.pressed]}
                        >
                          <View style={[styles.radio, chosen && styles.radioOn]}>{chosen && <FeatherIcon name="check" size={13} color={colors.text} />}</View>
                          <Text style={[styles.teamName, elsewhere !== null && styles.teamTaken]} numberOfLines={1}>
                            {team.name}
                          </Text>
                          {elsewhere !== null && <Text style={styles.taken}>{placeLabel(t, elsewhere)}</Text>}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}

              <View style={styles.summary}>
                <Text style={styles.summaryTitle}>{t('tournament.finish.summary')}</Text>
                {need > 0 && <SummaryLine icon="dollar-sign" text={t('tournament.finish.toPlayers', { amount: formatBirr(preview.money) })} />}
                {preview.gifts > 0 && need > 0 && <SummaryLine icon="gift" text={t('tournament.finish.gifts', { n: preview.gifts })} />}
                {preview.unusedPlaces > 0 && <SummaryLine icon="rotate-ccw" text={t('tournament.finish.unused', { n: preview.unusedPlaces })} />}
                {fees > 0 && (
                  <SummaryLine
                    icon="arrow-down-left"
                    text={t('tournament.finish.fees', { percent: 100 - PLATFORM_CUT_PERCENT, amount: formatBirr(preview.hostFees) })}
                  />
                )}
              </View>

              <Button
                label={t('tournament.finish.confirm')}
                icon="award"
                onPress={finish}
                loading={saving}
                disabled={!placements}
                style={styles.confirm}
              />
              {!placements && <Text style={styles.hint}>{t('tournament.finish.pickAll')}</Text>}
            </>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

function rewardSummary(rewards: TournamentReward[]): string {
  return rewards
    .map((r) => (r.kind === 'money' ? formatBirr(r.amount) : `${r.productName ?? ''} ${r.optionLabel ?? ''}`.trim()))
    .join(' + ');
}

function SummaryLine({ icon, text }: { icon: 'dollar-sign' | 'gift' | 'rotate-ccw' | 'arrow-down-left'; text: string }) {
  return (
    <View style={styles.summaryLine}>
      <FeatherIcon name={icon} size={16} color={colors.limeDark} />
      <Text style={styles.summaryText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xxl },
  loading: { marginTop: spacing.xl },
  muted: { marginTop: spacing.sm, fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.textMuted },
  name: { fontFamily: fonts.extrabold, fontSize: 22, lineHeight: 28, color: colors.text, letterSpacing: -0.4 },
  intro: { marginTop: spacing.xs, marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },

  place: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface, gap: spacing.sm },
  placeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  medal: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border },
  medalGold: { backgroundColor: '#F6D365' },
  medalSilver: { backgroundColor: '#DADFE3' },
  medalBronze: { backgroundColor: '#E8B48A' },
  medalText: { fontFamily: fonts.extrabold, fontSize: 13, color: colors.text },
  placeTitle: { flex: 1, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  rewardLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.limeInk },
  teams: { gap: spacing.xs + 2 },
  team: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    minHeight: 48,
    paddingHorizontal: spacing.md - 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  teamChosen: { borderColor: colors.limeDeep, backgroundColor: colors.limeSoft },
  pressed: { opacity: 0.75 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.limeDeep, backgroundColor: colors.lime },
  teamName: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  teamTaken: { color: colors.textMuted },
  taken: { fontFamily: fonts.medium, fontSize: 12, color: colors.textMuted },

  summary: { marginTop: spacing.sm, padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  summaryTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  summaryLine: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  summaryText: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.text },
  confirm: { marginTop: spacing.lg },
  hint: { marginTop: spacing.sm, textAlign: 'center', fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
});
