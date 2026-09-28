import { Redirect, router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon, type FeatherName } from '../../components/art/FeatherIcon';
import { RewardSheet } from '../../components/tournament/RewardSheet';
import { entryLabel, formatLine, gameLabel, modeLabel, placeLabel, platformLabel } from '../../components/tournament/labels';
import { Button } from '../../components/ui/Button';
import { DateTimeField } from '../../components/ui/DateTimeField';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { PillGroup } from '../../components/ui/PillGroup';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Stepper } from '../../components/ui/Stepper';
import { Column } from '../../components/ui/TabScroll';
import { TextField } from '../../components/ui/TextField';
import { useAuth } from '../../lib/auth';
import { formatBirr } from '../../lib/catalog';
import { confirmDestructive } from '../../lib/confirm';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import {
  GAMES,
  MAX_FEE,
  MIN_TEAMS,
  PRIZE_MAX,
  NAME_MAX,
  START_MAX_LEAD_MS,
  START_MIN_LEAD_MS,
  buildCreatePayload,
  clampTeamCount,
  detailsProblem,
  emptyHostForm,
  fillPlace,
  gridComplete,
  hostShareOfFee,
  maxPlaces,
  maxTeams,
  modeOf,
  modesOf,
  normalizeStreamUrl,
  parseBirr,
  resizeGrid,
  rewardTotals,
  serverErrorOf,
  setReward,
  streamPlatformOf,
  type FormProblem,
  type Game,
  type HostForm,
  type Reward,
  type TournamentKind,
} from '../../lib/tournamentRules';
import { createTournament, fetchRewardPacks } from '../../lib/tournaments';
import { useAsync } from '../../lib/useAsync';
import { useNow } from '../../lib/useNow';

type StepName = 'game' | 'kind' | 'details' | 'rewards' | 'review';
/** A live tournament has no reward grid (its prize is text on the details step), so it has one step less. */
const REGISTER_STEPS: StepName[] = ['game', 'kind', 'details', 'rewards', 'review'];
const LIVE_STEPS: StepName[] = ['game', 'kind', 'details', 'review'];
/** The time a button press happens (read in handlers only, never while rendering). */
const nowMs = () => Date.now();
const SERVER_MESSAGES: Record<string, StringKey> = {
  not_a_creator: 'tournament.err.not_a_creator',
  invalid_game_mode: 'tournament.err.mode',
  invalid_name: 'tournament.err.name',
  invalid_team_size: 'tournament.err.teamSize',
  invalid_team_count: 'tournament.err.teamCount',
  invalid_entry_fee: 'tournament.err.fee',
  invalid_start: 'tournament.err.startTooSoon',
  invalid_stream: 'tournament.err.streamInvalid',
  invalid_rewards: 'tournament.err.rewards',
  reward_pack_unavailable: 'tournament.err.reward_pack_unavailable',
  invalid_prize: 'tournament.err.prize',
  insufficient_balance: 'tournament.err.insufficient_balance',
  too_many_tournaments: 'tournament.err.too_many_tournaments',
};

/** Profile > Tournaments > Host a tournament: five short steps, then publish. Content creators only. */
export default function HostTournamentScreen() {
  const { session, initializing, isContentCreator, balance, refreshAccount } = useAuth();
  const t = useT();
  const clock = useNow(60_000);
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<HostForm>(emptyHostForm);
  const steps = form.kind === 'live' ? LIVE_STEPS : REGISTER_STEPS;
  const current: StepName = steps[Math.min(step, steps.length - 1)];
  const [problem, setProblem] = useState<StringKey | null>(null);
  const [editing, setEditing] = useState<{ place: number; slot: number } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
  const packs = useAsync(fetchRewardPacks, 'packs', !!session && isContentCreator);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isContentCreator) return <Redirect href="/tournaments" />;

  const mode = modeOf(form.game, form.mode);
  const update = (patch: Partial<HostForm>) => {
    setProblem(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  function chooseGame(game: Game) {
    const first = modesOf(game)[0];
    const size = Math.min(form.teamSize, first.maxTeamSize);
    update({ game, mode: first.id, teamSize: size, teamCount: clampTeamCount(form.teamCount, first, size), rewards: resizeGrid(form.rewards, form.rewards.length, size) });
    setStep(1);
  }

  function chooseKind(kind: TournamentKind) {
    update({ kind, rewards: resizeGrid(form.rewards, Math.min(form.rewards.length, maxPlaces(kind, form.teamCount)), form.teamSize) });
    setStep(2);
  }

  function chooseMode(id: string) {
    const m = modeOf(form.game, id)!;
    const size = Math.min(form.teamSize, m.maxTeamSize);
    const teams = clampTeamCount(form.teamCount, m, size);
    update({ mode: id, teamSize: size, teamCount: teams, rewards: resizeGrid(form.rewards, Math.min(form.rewards.length, maxPlaces(form.kind!, teams)), size) });
  }

  function chooseTeamSize(size: number) {
    const teams = clampTeamCount(form.teamCount, mode!, size);
    update({ teamSize: size, teamCount: teams, rewards: resizeGrid(form.rewards, Math.min(form.rewards.length, maxPlaces(form.kind!, teams)), size) });
  }

  function choosePlayers(players: number) {
    const teams = clampTeamCount(players / form.teamSize, mode!, form.teamSize);
    update({ teamCount: teams, rewards: resizeGrid(form.rewards, Math.min(form.rewards.length, maxPlaces(form.kind!, teams)), form.teamSize) });
  }

  const problemKey = (p: FormProblem): StringKey => `tournament.err.${p}` as StringKey;

  function next() {
    const now = Date.now();
    if (current === 'details') {
      const p = detailsProblem(form, now);
      if (p) return setProblem(problemKey(p));
    }
    if (current === 'rewards' && !gridComplete(form.rewards)) return setProblem('tournament.err.rewards');
    setProblem(null);
    if (current === 'review' || current === 'rewards' || current === 'details') refreshAccount();
    setStep((s) => Math.min(s + 1, steps.length - 1));
  }

  function back() {
    setProblem(null);
    if (step === 0) {
      if (router.canGoBack()) router.back();
      else router.replace('/tournaments');
    } else setStep((s) => s - 1);
  }

  async function publish() {
    if (publishingRef.current) return;
    const built = buildCreatePayload(form, nowMs());
    if (!built.ok) {
      setProblem(problemKey(built.problem));
      setStep(steps.indexOf(built.problem === 'rewards' ? 'rewards' : built.problem === 'game' ? 'game' : built.problem === 'kind' ? 'kind' : 'details'));
      return;
    }
    const sure = await confirmDestructive(
      t('tournament.host.publishTitle'),
      form.kind === 'register'
        ? `${t('tournament.host.payNow', { amount: formatBirr(dueNow) })} ${t('tournament.host.publishBody')}`
        : t('tournament.host.publishBody'),
      form.kind === 'register' ? t('tournament.host.payAndPublish') : t('tournament.host.publish'),
      'primary'
    );
    if (!sure) return;
    publishingRef.current = true;
    setPublishing(true);
    try {
      const id = await createTournament(built.payload);
      toast(t('tournament.host.published'));
      router.replace({ pathname: '/tournament/[id]', params: { id } });
    } catch (e) {
      const code = serverErrorOf(e);
      setProblem((code && SERVER_MESSAGES[code]) || 'tournament.err.generic');
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  const totals = rewardTotals(form.rewards);
  // What publishing takes from the wallet now (register only): every money reward + each product at today's price.
  const dueNow = form.kind === 'register' ? Math.round((totals.money + totals.productsPrice) * 100) / 100 : 0;
  const short = form.kind === 'register' && balance !== null && balance < dueNow;
  const url = normalizeStreamUrl(form.streamUrl);
  const fee = parseBirr(form.fee, { max: MAX_FEE });
  const placesMax = form.kind ? maxPlaces(form.kind, form.teamCount) : 1;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Column>
          <ScreenHeader title={t('tournament.host.title')} onBack={back} />
          <View style={styles.progress}>
            {steps.map((_, i) => (
              <View key={i} style={[styles.dot, i <= step && styles.dotOn]} />
            ))}
          </View>
          <Text style={styles.stepText}>{t('tournament.host.step', { n: step + 1, total: steps.length })}</Text>

          {current === 'game' && (
            <>
              <Text style={styles.title}>{t('tournament.host.gameTitle')}</Text>
              {GAMES.map((g) => (
                <Choice
                  key={g}
                  icon="award"
                  title={gameLabel(t, g)}
                  body={modesOf(g).map((m) => modeLabel(t, m.id)).join(' · ')}
                  selected={form.game === g}
                  onPress={() => chooseGame(g)}
                />
              ))}
            </>
          )}

          {current === 'kind' && (
            <>
              <Text style={styles.title}>{t('tournament.host.kindTitle')}</Text>
              <Choice icon="users" title={t('tournament.kind.register')} body={t('tournament.host.kind.registerBody')} selected={form.kind === 'register'} onPress={() => chooseKind('register')} />
              <Choice icon="radio" title={t('tournament.kind.live')} body={t('tournament.host.kind.liveBody')} selected={form.kind === 'live'} onPress={() => chooseKind('live')} />
            </>
          )}

          {current === 'details' && mode && form.kind && (
            <>
              <Text style={styles.title}>{t('tournament.host.detailsTitle')}</Text>
              <TextField
                label={t('tournament.host.name')}
                value={form.name}
                onChangeText={(name) => update({ name })}
                placeholder={t('tournament.host.namePlaceholder')}
                maxLength={NAME_MAX}
              />
              <Text style={styles.label}>{t('tournament.host.mode')}</Text>
              <PillGroup
                label={t('tournament.host.mode')}
                options={modesOf(form.game!).map((m) => ({ id: m.id, label: modeLabel(t, m.id) }))}
                value={form.mode!}
                onChange={chooseMode}
              />
              <View style={styles.gap} />
              <Stepper label={t('tournament.host.teamSize')} value={form.teamSize} min={1} max={mode.maxTeamSize} onChange={chooseTeamSize} />
              {form.kind === 'register' && (
                <Stepper
                  label={t('tournament.host.playerCount')}
                  value={form.teamSize * form.teamCount}
                  min={MIN_TEAMS * form.teamSize}
                  max={maxTeams(mode, form.teamSize) * form.teamSize}
                  step={form.teamSize}
                  onChange={choosePlayers}
                  hint={
                    form.teamSize === 1
                      ? t('tournament.host.splitSolo', { players: form.teamCount })
                      : t('tournament.host.split', { teams: form.teamCount, size: form.teamSize, players: form.teamCount * form.teamSize })
                  }
                />
              )}
              {form.kind === 'register' && (
                <>
                  <Text style={styles.label}>{t('tournament.host.entry')}</Text>
                  <PillGroup
                    label={t('tournament.host.entry')}
                    options={[
                      { id: 'free', label: t('tournament.free') },
                      { id: 'paid', label: t('tournament.paid') },
                    ]}
                    value={form.paid ? 'paid' : 'free'}
                    onChange={(v) => update({ paid: v === 'paid' })}
                  />
                  <View style={styles.gap} />
                  {form.paid && (
                    <>
                      <TextField label={t('tournament.host.fee')} value={form.fee} onChangeText={(v) => update({ fee: v })} keyboardType="decimal-pad" placeholder="50" />
                      {fee !== null && <Text style={styles.hint}>{t('tournament.host.feeYouGet', { amount: formatBirr(hostShareOfFee(fee)) })}</Text>}
                      <Text style={styles.note}>{t('tournament.host.feeNote')}</Text>
                    </>
                  )}
                </>
              )}
              <DateTimeField
                label={t('tournament.host.startsAt')}
                value={form.startsAt}
                onChange={(startsAt) => update({ startsAt })}
                placeholder={t('tournament.host.pickTime')}
                minimumDate={new Date(clock + START_MIN_LEAD_MS)}
                maximumDate={new Date(clock + START_MAX_LEAD_MS)}
              />
              <TextField
                label={form.kind === 'live' ? t('tournament.host.stream') : t('tournament.host.streamOptional')}
                value={form.streamUrl}
                onChangeText={(streamUrl) => update({ streamUrl })}
                placeholder={t('tournament.host.streamPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              {url ? <Text style={styles.hint}>{t('tournament.host.streamDetected', { platform: platformLabel(t, streamPlatformOf(url)) })}</Text> : null}
              {form.kind === 'live' && (
                <TextField
                  label={t('tournament.host.prize')}
                  value={form.prize}
                  onChangeText={(prize) => update({ prize })}
                  placeholder={t('tournament.host.prizePlaceholder')}
                  maxLength={PRIZE_MAX}
                  multiline
                  boxStyle={styles.prizeBox}
                />
              )}
            </>
          )}

          {current === 'rewards' && (
            <>
              <Text style={styles.title}>{t('tournament.host.rewardsTitle')}</Text>
              <Text style={styles.lead}>{t('tournament.host.rewardsBody')}</Text>
              <Stepper
                label={t('tournament.host.places')}
                value={form.rewards.length}
                min={1}
                max={placesMax}
                onChange={(n) => update({ rewards: resizeGrid(form.rewards, n, form.teamSize) })}
              />
              <View style={styles.places}>
                {form.rewards.map((row, p) => (
                  <View key={p} style={styles.place}>
                    <View style={styles.placeHead}>
                      <View style={[styles.medal, p === 0 && styles.medalGold]}>
                        <Text style={styles.medalText}>{p + 1}</Text>
                      </View>
                      <Text style={styles.placeTitle}>{placeLabel(t, p + 1)}</Text>
                    </View>
                    {row.map((reward, s) => (
                      <Pressable
                        key={s}
                        onPress={() => setEditing({ place: p + 1, slot: s + 1 })}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.slot, !reward && styles.slotEmpty, pressed && styles.pressed]}
                      >
                        {form.teamSize > 1 && <Text style={styles.slotLabel}>{t('tournament.detail.player', { n: s + 1 })}</Text>}
                        <Text style={[styles.slotValue, !reward && styles.slotPrompt]} numberOfLines={2}>
                          {reward ? rewardText(reward) : t('tournament.host.chooseReward')}
                        </Text>
                        <FeatherIcon name={reward ? 'edit-2' : 'plus'} size={15} color={colors.textMuted} />
                      </Pressable>
                    ))}
                  </View>
                ))}
              </View>
              <Text style={styles.totals}>{totalsText(t, totals)}</Text>
            </>
          )}

          {current === 'review' && form.game && form.kind && (
            <>
              <Text style={styles.title}>{t('tournament.host.reviewTitle')}</Text>
              <View style={styles.review}>
                <Text style={styles.reviewName}>{form.name.trim()}</Text>
                <ReviewLine icon={form.kind === 'live' ? 'radio' : 'users'} text={`${t(`tournament.kind.${form.kind}`)} · ${gameLabel(t, form.game)} · ${modeLabel(t, form.mode!)}`} />
                <ReviewLine icon="calendar" text={form.startsAt ? formatDateTime(form.startsAt.toISOString()) : '—'} />
                <ReviewLine icon="users" text={formatLine(t, form.teamSize, form.kind === 'register' ? form.teamCount : null)} />
                {form.kind === 'register' && <ReviewLine icon="tag" text={entryLabel(t, form.paid && fee ? fee : 0)} />}
                {url && <ReviewLine icon="video" text={`${platformLabel(t, streamPlatformOf(url))} · ${url}`} />}
                <ReviewLine icon="award" text={form.kind === 'live' ? form.prize.trim() : totalsText(t, totals)} />
              </View>
              {form.kind === 'register' && (
                <View style={[styles.payBox, short && styles.payBoxShort]}>
                  <Text style={styles.payTitle}>{t('tournament.host.payNow', { amount: formatBirr(dueNow) })}</Text>
                  <Text style={styles.payBody}>{t('tournament.host.payNote')}</Text>
                  <Text style={[styles.payBalance, short && styles.payBalanceShort]}>
                    {t('tournament.host.yourBalance', { amount: balance === null ? '—' : formatBirr(balance) })}
                  </Text>
                  {short && <Button label={t('common.topUp')} variant="dark" onPress={() => router.push('/wallet')} style={styles.topUp} />}
                </View>
              )}
            </>
          )}

          {problem && <View style={styles.problem}><ErrorBanner message={t(problem)} /></View>}

          <View style={styles.nav}>
            {step > 0 && <Button label={t('tournament.host.back')} variant="outline" onPress={back} style={styles.navButton} />}
            {step >= 2 && current !== 'review' && <Button label={t('tournament.host.next')} onPress={next} style={styles.navButton} />}
            {current === 'review' && <Button label={form.kind === 'register' ? t('tournament.host.payAndPublish') : t('tournament.host.publish')} onPress={publish} loading={publishing} style={styles.navButton} />}
          </View>
        </Column>
      </ScrollView>

      <RewardSheet
        target={
          editing
            ? { ...editing, placeName: placeLabel(t, editing.place), current: form.rewards[editing.place - 1]?.[editing.slot - 1] ?? null }
            : null
        }
        teamSize={form.teamSize}
        packs={packs.data}
        packsFailed={packs.status === 'error'}
        onRetryPacks={packs.reload}
        onClose={() => setEditing(null)}
        onSave={(reward, everyone) => {
          if (!editing) return;
          update({ rewards: everyone ? fillPlace(form.rewards, editing.place, reward) : setReward(form.rewards, editing.place, editing.slot, reward) });
          setEditing(null);
        }}
      />
    </SafeAreaView>
  );
}

function rewardText(r: Reward): string {
  return r.kind === 'money' ? formatBirr(r.amount) : `${r.productName} · ${r.optionLabel}${r.regionLabel ? ` (${r.regionLabel})` : ''}`;
}

function totalsText(t: ReturnType<typeof useT>, totals: ReturnType<typeof rewardTotals>): string {
  return totals.products > 0
    ? t('tournament.host.totalsWithItems', { money: formatBirr(totals.money), n: totals.products, price: formatBirr(totals.productsPrice) })
    : t('tournament.host.totals', { money: formatBirr(totals.money) });
}

function Choice({ icon, title, body, selected, onPress }: { icon: FeatherName; title: string; body: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}. ${body}`}
      style={({ pressed }) => [styles.choice, selected && styles.choiceOn, pressed && styles.pressed]}
    >
      <View style={styles.choiceIcon}>
        <FeatherIcon name={icon} size={22} color={colors.limeDark} />
      </View>
      <View style={styles.choiceText}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceBody}>{body}</Text>
      </View>
      <FeatherIcon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

function ReviewLine({ icon, text }: { icon: FeatherName; text: string }) {
  return (
    <View style={styles.reviewLine}>
      <FeatherIcon name={icon} size={15} color={colors.textMuted} />
      <Text style={styles.reviewText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xxl },
  progress: { flexDirection: 'row', gap: 6, marginTop: spacing.xs },
  dot: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  dotOn: { backgroundColor: colors.limeDeep },
  stepText: { marginTop: spacing.sm, fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  title: { marginTop: spacing.md, marginBottom: spacing.md, fontFamily: fonts.extrabold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  lead: { marginTop: -spacing.sm, marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  label: { fontFamily: fonts.semibold, fontSize: 13.5, color: colors.limeInk, marginBottom: 7 },
  gap: { height: spacing.md },
  hint: { marginTop: -spacing.sm, marginBottom: spacing.sm, fontFamily: fonts.semibold, fontSize: 13, color: colors.limeInk },
  note: { marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },

  choice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, marginBottom: spacing.sm + 4, borderRadius: radius.lg, borderWidth: 1.5, borderColor: 'transparent', backgroundColor: colors.surface },
  choiceOn: { borderColor: colors.limeInk },
  pressed: { backgroundColor: colors.border },
  choiceIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  choiceText: { flex: 1, minWidth: 0 },
  choiceTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  choiceBody: { marginTop: 2, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },

  places: { gap: spacing.sm + 2 },
  place: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface, gap: spacing.sm },
  placeHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  medal: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border },
  medalGold: { backgroundColor: colors.lime },
  medalText: { fontFamily: fonts.extrabold, fontSize: 13, color: colors.text },
  placeTitle: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  slot: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 46, paddingHorizontal: spacing.sm + 4, borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  slotEmpty: { borderStyle: 'dashed', borderColor: colors.borderStrong },
  slotLabel: { width: 72, fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  slotValue: { flex: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  slotPrompt: { color: colors.limeInk },
  totals: { marginTop: spacing.md, fontFamily: fonts.semibold, fontSize: 13.5, lineHeight: 19, color: colors.text },

  review: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface, gap: spacing.sm + 2 },
  reviewName: { fontFamily: fonts.extrabold, fontSize: 20, color: colors.text, letterSpacing: -0.4 },
  reviewLine: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  reviewText: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.text },

  problem: { marginTop: spacing.md },
  prizeBox: { height: 96, alignItems: 'flex-start', paddingTop: spacing.sm },
  payBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.limeSoft, gap: 4 },
  payBoxShort: { backgroundColor: colors.dangerBg },
  payTitle: { fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  payBody: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  payBalance: { marginTop: 4, fontFamily: fonts.semibold, fontSize: 13.5, color: colors.limeDark },
  payBalanceShort: { color: colors.danger },
  topUp: { marginTop: spacing.sm },
  nav: { flexDirection: 'row', gap: spacing.sm + 2, marginTop: spacing.lg },
  navButton: { flex: 1 },
});
