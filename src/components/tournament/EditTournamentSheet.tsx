import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useT } from '../../lib/i18n';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, spacing } from '../../lib/theme';
import {
  NAME_MAX,
  NAME_MIN,
  START_MAX_LEAD_MS,
  START_MIN_LEAD_MS,
  normalizeStreamUrl,
  serverErrorOf,
  streamPlatformOf,
} from '../../lib/tournamentRules';
import { updateTournament, type Tournament } from '../../lib/tournaments';
import { platformLabel } from './labels';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { DateTimeField } from '../ui/DateTimeField';
import { ErrorBanner } from '../ui/ErrorBanner';
import { TextField } from '../ui/TextField';
import { useNow } from '../../lib/useNow';

type Props = { visible: boolean; tournament: Tournament; onClose: () => void; onSaved: () => void };

/** The three things a host may change after publishing: the name, the start time and the stream link. */
export function EditTournamentSheet({ visible, tournament, onClose, onSaved }: Props) {
  const t = useT();
  const clock = useNow(60_000);
  const [name, setName] = useState(tournament.name);
  const [startsAt, setStartsAt] = useState<Date | null>(new Date(tournament.startsAt));
  const [stream, setStream] = useState(tournament.streamUrl ?? '');
  const [error, setError] = useState<StringKey | null>(null);
  const [saving, setSaving] = useState(false);
  // Reset the form each time the sheet opens on fresh data.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const openKey = visible ? `${tournament.id}|${tournament.name}|${tournament.startsAt}|${tournament.streamUrl}` : null;
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (openKey) {
      setName(tournament.name);
      setStartsAt(new Date(tournament.startsAt));
      setStream(tournament.streamUrl ?? '');
      setError(null);
    }
  }

  async function save() {
    if (saving) return;
    const trimmed = name.trim();
    if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return setError('tournament.err.name');
    if (!startsAt) return setError('tournament.err.startMissing');
    const changes: Parameters<typeof updateTournament>[1] = {};
    if (trimmed !== tournament.name) changes.name = trimmed;
    if (startsAt.getTime() !== new Date(tournament.startsAt).getTime()) {
      const lead = startsAt.getTime() - Date.now();
      if (lead < START_MIN_LEAD_MS) return setError('tournament.err.startTooSoon');
      if (lead > START_MAX_LEAD_MS) return setError('tournament.err.startTooFar');
      changes.starts_at = startsAt.toISOString();
    }
    const url = stream.trim() ? normalizeStreamUrl(stream) : null;
    if (stream.trim() && !url) return setError('tournament.err.streamInvalid');
    if (!url && tournament.kind === 'live') return setError('tournament.err.streamRequired');
    if (url !== tournament.streamUrl) {
      changes.stream_url = url ?? '';
      changes.stream_platform = url ? streamPlatformOf(url) : '';
    }
    if (Object.keys(changes).length === 0) return onClose();

    setError(null);
    setSaving(true);
    try {
      await updateTournament(tournament.id, changes);
      onSaved();
    } catch (e) {
      const code = serverErrorOf(e);
      const map: Record<string, StringKey> = {
        invalid_name: 'tournament.err.name',
        invalid_start: 'tournament.err.startTooSoon',
        invalid_stream: 'tournament.err.streamInvalid',
        tournament_closed: 'tournament.err.tournament_closed',
      };
      setError((code && map[code]) || 'tournament.err.generic');
    } finally {
      setSaving(false);
    }
  }

  const url = normalizeStreamUrl(stream);
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('tournament.detail.editTitle')}>
      <Text style={styles.note}>{t('tournament.detail.editNote')}</Text>
      {error && <ErrorBanner message={t(error)} />}
      <TextField label={t('tournament.host.name')} value={name} onChangeText={setName} maxLength={NAME_MAX} />
      <DateTimeField
        label={t('tournament.host.startsAt')}
        value={startsAt}
        onChange={setStartsAt}
        placeholder={t('tournament.host.pickTime')}
        minimumDate={new Date(clock + START_MIN_LEAD_MS)}
        maximumDate={new Date(clock + START_MAX_LEAD_MS)}
      />
      <TextField
        label={tournament.kind === 'live' ? t('tournament.host.stream') : t('tournament.host.streamOptional')}
        value={stream}
        onChangeText={setStream}
        placeholder={t('tournament.host.streamPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      {url ? <Text style={styles.detected}>{t('tournament.host.streamDetected', { platform: platformLabel(t, streamPlatformOf(url)) })}</Text> : null}
      <Button label={t('tournament.reward.save')} onPress={save} loading={saving} style={styles.save} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
  detected: { marginTop: -spacing.sm, marginBottom: spacing.md, fontFamily: fonts.medium, fontSize: 13, color: colors.limeInk },
  save: { marginTop: spacing.sm },
});
