import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../../components/art/FeatherIcon';
import { Avatar } from '../../../components/market/Avatar';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../../components/ui/ScreenHeader';
import { Column } from '../../../components/ui/TabScroll';
import { TextField } from '../../../components/ui/TextField';
import { useAuth } from '../../../lib/auth';
import { formatBirr } from '../../../lib/catalog';
import { confirmDestructive } from '../../../lib/confirm';
import { findRecipient } from '../../../lib/gift';
import { looksLikeEmail } from '../../../lib/giftMode';
import { useT } from '../../../lib/i18n';
import type { StringKey } from '../../../lib/strings';
import { colors, fonts, radius, spacing } from '../../../lib/theme';
import { useToast } from '../../../lib/toast';
import {
  GAME_ID,
  TEAM_NAME_MAX,
  emptySlots,
  serverErrorOf,
  slotVerified,
  teamProblem,
  teamSavePayload,
  type TeamSlot,
} from '../../../lib/tournamentRules';
import { discardTeam, fetchMyTeam, fetchTournament, registerTeam, saveTeam, type Team, type Tournament } from '../../../lib/tournaments';
import { useAsync } from '../../../lib/useAsync';
import { useNow } from '../../../lib/useNow';
import { validateId } from '../../../lib/validateId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per slot, what the last Find / Check said (shown under that slot). */
type SlotNote = { email?: StringKey; check?: StringKey };

const SERVER_MESSAGES: Record<string, StringKey> = {
  team_name_taken: 'tournament.team.err.team_name_taken',
  invalid_team_name: 'tournament.team.err.teamName',
  already_in_team: 'tournament.team.err.already_in_team',
  tournament_full: 'tournament.team.err.tournament_full',
  tournament_closed: 'tournament.team.err.tournament_closed',
  not_register: 'tournament.team.err.tournament_closed',
  id_not_verified: 'tournament.team.err.id_not_verified',
  insufficient_balance: 'tournament.team.err.insufficient_balance',
  host_cannot_join: 'tournament.team.err.host_cannot_join',
  duplicate_member: 'tournament.team.err.duplicatePlayer',
  duplicate_game_id: 'tournament.team.err.duplicateGameId',
  team_incomplete: 'tournament.team.err.teamIncomplete',
  team_locked: 'tournament.team.err.tournament_closed',
};

/**
 * Register a team for a tournament (captain = the signed-in person = player 1). Loads the captain's saved draft, or
 * shows a registered team read-only. Every player is an app account found by exact email; every game ID is checked
 * with the real checker (validate-id), and only a checked ID is ever saved.
 */
export default function TeamScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, initializing, user, profile } = useAuth();
  const validId = typeof id === 'string' && UUID.test(id);
  const data = useAsync(
    async () => {
      const [tournament, team] = await Promise.all([fetchTournament(id!), fetchMyTeam(id!)]);
      return { tournament, team };
    },
    id ?? '',
    !!session && validId
  );

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/tournament/[id]', params: { id: id! } }));

  if (!validId || (data.status === 'ready' && !data.data?.tournament)) {
    return <Shell back={back}><NotFound /></Shell>;
  }
  if (!data.data || !user) {
    return (
      <Shell back={back}>
        {data.status === 'error' ? <Button label="↻" variant="outline" onPress={data.reload} /> : <ActivityIndicator color={colors.limeInk} style={styles.loading} />}
      </Shell>
    );
  }
  const { tournament, team } = data.data;
  if (team && team.status !== 'draft') {
    return <Shell back={back}><RegisteredTeam tournament={tournament!} team={team} /></Shell>;
  }
  return (
    <TeamEditor
      key={team?.id ?? 'new'}
      back={back}
      tournament={tournament!}
      draft={team}
      captain={{ id: user.id, name: profile?.display_name || '', avatarUrl: profile?.avatar_url ?? null }}
    />
  );
}

function Shell({ back, children }: { back: () => void; children: React.ReactNode }) {
  const t = useT();
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Column>
          <ScreenHeader title={t('tournament.team.title')} onBack={back} />
          {children}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

function NotFound() {
  const t = useT();
  return <Text style={styles.muted}>{t('tournament.detail.notFound')}</Text>;
}

function slotsFromDraft(tournament: Tournament, draft: Team | null, captain: { id: string; name: string; avatarUrl: string | null }): TeamSlot[] {
  const slots = emptySlots(tournament.teamSize, captain);
  for (const m of draft?.members ?? []) {
    const s = slots[m.slot - 1];
    if (!s) continue;
    if (m.slot > 1) {
      s.userId = m.userId;
      s.name = m.name;
      s.avatarUrl = m.avatarUrl;
    }
    if (m.gameId && m.verified) {
      s.gameId = m.gameId;
      s.checkedGameId = m.gameId;
      s.validationId = m.validationId;
      s.playerName = m.playerName;
    }
  }
  return slots;
}

function TeamEditor({
  back,
  tournament,
  draft,
  captain,
}: {
  back: () => void;
  tournament: Tournament;
  draft: Team | null;
  captain: { id: string; name: string; avatarUrl: string | null };
}) {
  const t = useT();
  const toast = useToast();
  const { balance, refreshAccount } = useAuth();
  const [name, setName] = useState(draft?.name ?? '');
  const [slots, setSlots] = useState<TeamSlot[]>(() => slotsFromDraft(tournament, draft, captain));
  const [emails, setEmails] = useState<string[]>(() => Array.from({ length: tournament.teamSize }, () => ''));
  const [notes, setNotes] = useState<SlotNote[]>(() => Array.from({ length: tournament.teamSize }, () => ({})));
  const [busySlot, setBusySlot] = useState<string | null>(null); // `${slot}:find` | `${slot}:check`
  const [problem, setProblem] = useState<StringKey | null>(null);
  const [saving, setSaving] = useState<'save' | 'register' | 'discard' | null>(null);
  const [teamId, setTeamId] = useState<string | null>(draft?.id ?? null);
  const working = useRef(false);
  const now = useNow();

  const check = tournament.idCheck;
  const closed = tournament.status !== 'published' || new Date(tournament.startsAt).getTime() <= now;
  const full = tournament.teamCount !== null && tournament.teamsRegistered >= tournament.teamCount;

  const patchSlot = (slot: number, patch: Partial<TeamSlot>) => {
    setProblem(null);
    setSlots((all) => all.map((s) => (s.slot === slot ? { ...s, ...patch } : s)));
  };
  const note = (slot: number, n: SlotNote) => setNotes((all) => all.map((x, i) => (i === slot - 1 ? n : x)));

  async function find(slot: number) {
    const email = emails[slot - 1].trim();
    if (!looksLikeEmail(email) || busySlot) {
      if (!looksLikeEmail(email)) note(slot, { email: 'tournament.team.notFound' });
      return;
    }
    setBusySlot(`${slot}:find`);
    const found = await findRecipient(email);
    setBusySlot(null);
    if (found.kind === 'found') {
      if (slots.some((s) => s.slot !== slot && s.userId === found.recipient.id)) {
        note(slot, { email: 'tournament.team.err.duplicatePlayer' });
        return;
      }
      patchSlot(slot, { userId: found.recipient.id, name: found.recipient.name, avatarUrl: found.recipient.avatarUrl });
      note(slot, {});
    } else {
      const key: StringKey =
        found.kind === 'self' ? 'tournament.team.self' : found.kind === 'not_found' ? 'tournament.team.notFound' : found.kind === 'too_many' ? 'tournament.team.tooMany' : 'tournament.team.lookupError';
      note(slot, { email: key });
    }
  }

  async function checkId(slot: number) {
    const s = slots[slot - 1];
    const gameId = s.gameId.trim();
    if (!check || !GAME_ID.test(gameId) || busySlot) {
      if (!GAME_ID.test(gameId)) note(slot, { check: 'tournament.team.invalid' });
      return;
    }
    if (slots.some((o) => o.slot !== slot && o.gameId.trim() === gameId)) {
      note(slot, { check: 'tournament.team.err.duplicateGameId' });
      return;
    }
    setBusySlot(`${slot}:check`);
    const result = await validateId(check.regionId, { [check.fieldKey]: gameId });
    setBusySlot(null);
    if (result.status === 'valid') {
      patchSlot(slot, { validationId: result.validationId, checkedGameId: gameId, playerName: result.playerName });
      note(slot, {});
    } else {
      patchSlot(slot, { validationId: null, checkedGameId: null, playerName: null });
      note(slot, { check: result.status === 'invalid' ? 'tournament.team.invalid' : result.reason === 'busy' ? 'tournament.team.busy' : 'tournament.team.unavailable' });
    }
  }

  function failed(e: unknown) {
    const code = serverErrorOf(e);
    if (code === 'id_not_verified') {
      // The server says which slot's check is too old: make that slot ask again.
      const slot = Number((e as { details?: string } | null)?.details);
      if (Number.isInteger(slot) && slot >= 1) patchSlot(slot, { validationId: null, checkedGameId: null, playerName: null });
    }
    setProblem((code && SERVER_MESSAGES[code]) || 'tournament.team.err.generic');
  }

  async function persist(): Promise<string> {
    const saved = await saveTeam(tournament.id, teamSavePayload(name, slots));
    setTeamId(saved);
    return saved;
  }

  async function saveDraft() {
    if (working.current) return;
    const n = name.trim();
    if (n.length < 2 || n.length > TEAM_NAME_MAX) return setProblem('tournament.team.err.teamName');
    working.current = true;
    setSaving('save');
    try {
      await persist();
      toast(t('tournament.team.saved'));
    } catch (e) {
      failed(e);
    } finally {
      working.current = false;
      setSaving(null);
    }
  }

  async function register() {
    if (working.current) return;
    const p = teamProblem(name, slots);
    if (p) return setProblem(`tournament.team.err.${p}` as StringKey);
    const fee = tournament.entryFee;
    const sure = await confirmDestructive(
      t('tournament.team.confirmTitle'),
      fee > 0 ? t('tournament.team.confirmBody', { amount: formatBirr(fee) }) : t('tournament.team.confirmFree'),
      fee > 0 ? t('tournament.team.registerPay', { amount: formatBirr(fee) }) : t('tournament.team.register'),
      'primary'
    );
    if (!sure) return;
    working.current = true;
    setSaving('register');
    try {
      const saved = await persist();
      await registerTeam(saved);
      refreshAccount();
      toast(t('tournament.team.registered'));
      router.replace({ pathname: '/tournament/[id]', params: { id: tournament.id } });
    } catch (e) {
      failed(e);
    } finally {
      working.current = false;
      setSaving(null);
    }
  }

  async function discard() {
    if (!teamId || working.current) return;
    const sure = await confirmDestructive(t('tournament.team.discardTitle'), t('tournament.team.discardBody'), t('tournament.team.discard'));
    if (!sure) return;
    working.current = true;
    setSaving('discard');
    try {
      await discardTeam(teamId);
      router.replace({ pathname: '/tournament/[id]', params: { id: tournament.id } });
    } catch (e) {
      failed(e);
    } finally {
      working.current = false;
      setSaving(null);
    }
  }

  const fee = tournament.entryFee;
  const short = fee > 0 && balance !== null && balance < fee;
  const blocked = closed || full || !check;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Column>
          <ScreenHeader title={t('tournament.team.title')} onBack={back} />
          <Text style={styles.tournamentName} numberOfLines={2}>
            {tournament.name}
          </Text>
          <Text style={styles.lead}>{t('tournament.team.hint')}</Text>

          {!check && <ErrorBanner message={t('tournament.team.noCheck')} />}
          {closed && <ErrorBanner message={t('tournament.team.err.tournament_closed')} />}
          {!closed && full && <ErrorBanner message={t('tournament.team.err.tournament_full')} />}

          <TextField label={t('tournament.team.name')} value={name} onChangeText={(v) => { setName(v); setProblem(null); }} placeholder={t('tournament.team.namePlaceholder')} maxLength={TEAM_NAME_MAX} />

          {slots.map((s) => {
            const verified = slotVerified(s);
            const n = notes[s.slot - 1] ?? {};
            return (
              <View key={s.slot} style={[styles.slot, verified && styles.slotDone]}>
                <View style={styles.slotHead}>
                  <Text style={styles.slotTitle}>{s.slot === 1 ? t('tournament.team.captain') : t('tournament.detail.player', { n: s.slot })}</Text>
                  {verified && <FeatherIcon name="check-circle" size={18} color={colors.limeInk} />}
                </View>

                {s.slot > 1 && !s.userId && (
                  <>
                    <View style={styles.inline}>
                      <View style={styles.grow}>
                        <TextField
                          label={t('tournament.team.email')}
                          value={emails[s.slot - 1]}
                          onChangeText={(v) => {
                            setEmails((all) => all.map((x, i) => (i === s.slot - 1 ? v : x)));
                            note(s.slot, {});
                          }}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="email-address"
                          placeholder="name@gmail.com"
                          onSubmitEditing={() => find(s.slot)}
                        />
                      </View>
                      <Button label={t('tournament.team.find')} variant="dark" onPress={() => find(s.slot)} loading={busySlot === `${s.slot}:find`} style={styles.sideButton} />
                    </View>
                    {n.email && <Text style={styles.noteBad}>{t(n.email)}</Text>}
                  </>
                )}

                {s.userId && (
                  <View style={styles.person}>
                    <Avatar name={s.name} uri={s.avatarUrl} size={34} />
                    <Text style={styles.personName} numberOfLines={1}>
                      {s.name || '—'}
                    </Text>
                    {s.slot > 1 && (
                      <Pressable
                        onPress={() => {
                          patchSlot(s.slot, { userId: null, name: null, avatarUrl: null, gameId: '', validationId: null, checkedGameId: null, playerName: null });
                          note(s.slot, {});
                        }}
                        hitSlop={8}
                        accessibilityRole="button"
                      >
                        <Text style={styles.change}>{t('tournament.team.change')}</Text>
                      </Pressable>
                    )}
                  </View>
                )}

                {s.userId && check && (
                  <>
                    <View style={styles.inline}>
                      <View style={styles.grow}>
                        <TextField
                          label={check.fieldLabel}
                          value={s.gameId}
                          onChangeText={(v) => {
                            patchSlot(s.slot, { gameId: v });
                            note(s.slot, {});
                          }}
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="number-pad"
                          onSubmitEditing={() => checkId(s.slot)}
                        />
                      </View>
                      {!verified && (
                        <Button label={t('tournament.team.check')} variant="dark" onPress={() => checkId(s.slot)} loading={busySlot === `${s.slot}:check`} style={styles.sideButton} />
                      )}
                    </View>
                    {verified && <Text style={styles.noteGood}>{s.playerName ? t('tournament.team.checked', { name: s.playerName }) : t('tournament.team.checkedNoName')}</Text>}
                    {n.check && <Text style={styles.noteBad}>{t(n.check)}</Text>}
                  </>
                )}
              </View>
            );
          })}

          {problem && <ErrorBanner message={t(problem)} />}
          {short && !blocked && (
            <View style={styles.shortBox}>
              <Text style={styles.shortText}>{t('tournament.team.err.insufficient_balance')}</Text>
              <Button label={t('common.topUp')} variant="dark" onPress={() => router.push('/wallet')} />
            </View>
          )}

          <Button
            label={fee > 0 ? t('tournament.team.registerPay', { amount: formatBirr(fee) }) : t('tournament.team.register')}
            onPress={register}
            loading={saving === 'register'}
            disabled={blocked || saving !== null}
            style={styles.primary}
          />
          <Button label={t('tournament.team.save')} variant="outline" onPress={saveDraft} loading={saving === 'save'} disabled={blocked || saving !== null} style={styles.secondary} />
          {teamId && (
            <Pressable onPress={discard} disabled={saving !== null} accessibilityRole="button" style={({ pressed }) => [styles.discard, pressed && styles.pressed]}>
              {saving === 'discard' ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.discardText}>{t('tournament.team.discard')}</Text>}
            </Pressable>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

function RegisteredTeam({ tournament, team }: { tournament: Tournament; team: Team }) {
  const t = useT();
  return (
    <>
      <Text style={styles.tournamentName} numberOfLines={2}>
        {tournament.name}
      </Text>
      <View style={styles.teamCard}>
        <View style={styles.slotHead}>
          <Text style={styles.teamName} numberOfLines={1}>
            {team.name}
          </Text>
          <View style={[styles.badge, team.status === 'cancelled' && styles.badgeOff]}>
            <Text style={[styles.badgeText, team.status === 'cancelled' && styles.badgeTextOff]}>
              {team.status === 'cancelled' ? t('tournament.phase.cancelled') : t('tournament.team.registeredBadge')}
            </Text>
          </View>
        </View>
        {team.members.map((m) => (
          <View key={m.slot} style={styles.person}>
            <Avatar name={m.name} uri={m.avatarUrl} size={34} />
            <View style={styles.grow}>
              <Text style={styles.personName} numberOfLines={1}>
                {m.name || '—'}
              </Text>
              <Text style={styles.personMeta} numberOfLines={1}>
                {[m.playerName, m.gameId].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
        ))}
        {team.isCaptain && team.feePaid > 0 && <Text style={styles.personMeta}>{t('tournament.team.feePaid', { amount: formatBirr(team.feePaid) })}</Text>}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xxl },
  loading: { marginTop: spacing.xl },
  muted: { fontFamily: fonts.regular, fontSize: 15, color: colors.textMuted },
  tournamentName: { marginTop: spacing.xs, fontFamily: fonts.extrabold, fontSize: 20, color: colors.text, letterSpacing: -0.4 },
  lead: { marginTop: 4, marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },

  slot: { padding: spacing.md, paddingBottom: spacing.sm, marginBottom: spacing.sm + 4, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: 'transparent' },
  slotDone: { borderColor: colors.limeSoft },
  slotHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  slotTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  inline: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  grow: { flex: 1, minWidth: 0 },
  sideButton: { marginBottom: spacing.md },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, marginBottom: spacing.sm + 2 },
  personName: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  personMeta: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  change: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.limeInk },
  noteGood: { marginTop: -spacing.sm, marginBottom: spacing.sm, fontFamily: fonts.semibold, fontSize: 13, color: colors.limeInk },
  noteBad: { marginTop: -spacing.sm, marginBottom: spacing.sm, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },

  shortBox: { padding: spacing.md, marginBottom: spacing.sm, borderRadius: radius.lg, backgroundColor: colors.dangerBg, gap: spacing.sm },
  shortText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.danger },
  primary: { marginTop: spacing.sm },
  secondary: { marginTop: spacing.sm },
  discard: { marginTop: spacing.sm, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  pressed: { backgroundColor: colors.border },
  discardText: { fontFamily: fonts.bold, fontSize: 15, color: colors.danger },

  teamCard: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.surface },
  teamName: { flex: 1, fontFamily: fonts.extrabold, fontSize: 18, color: colors.text },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: colors.limeSoft },
  badgeOff: { backgroundColor: colors.border },
  badgeText: { fontFamily: fonts.bold, fontSize: 12, color: colors.limeDark },
  badgeTextOff: { color: colors.textMuted },
});
