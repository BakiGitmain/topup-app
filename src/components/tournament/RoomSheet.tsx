import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useT } from '../../lib/i18n';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, spacing } from '../../lib/theme';
import { ROOM_MAX, roomProblem, serverErrorOf } from '../../lib/tournamentRules';
import { postRoom, type Tournament } from '../../lib/tournaments';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/ErrorBanner';
import { TextField } from '../ui/TextField';

type Props = { visible: boolean; tournament: Tournament; onClose: () => void; onPosted: () => void };

/**
 * The host types the custom room's ID and password from the game and posts them (or corrects them). The sheet itself is
 * the deliberate step (a confirm dialog can't open over a sheet on iOS), so the button says what happens: players are
 * notified. A second tap while it is sending does nothing.
 */
export function RoomSheet({ visible, tournament, onClose, onPosted }: Props) {
  const t = useT();
  const [roomId, setRoomId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<StringKey | null>(null);
  const [saving, setSaving] = useState(false);
  const sending = useRef(false);
  // Fill the form with what is posted each time the sheet opens.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const openKey = visible ? `${tournament.id}|${tournament.room?.roomId ?? ''}|${tournament.room?.password ?? ''}` : null;
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (openKey) {
      setRoomId(tournament.room?.roomId ?? '');
      setPassword(tournament.room?.password ?? '');
      setError(null);
    }
  }

  async function post() {
    if (sending.current) return;
    const problem = roomProblem(roomId, password);
    if (problem) return setError(`tournament.room.err.${problem}` as StringKey);
    sending.current = true;
    setError(null);
    setSaving(true);
    try {
      await postRoom(tournament.id, roomId.trim(), password.trim());
      onPosted();
    } catch (e) {
      const code = serverErrorOf(e);
      setError(
        code === 'invalid_room' ? 'tournament.room.err.roomChars' : code === 'tournament_closed' ? 'tournament.err.tournament_closed' : 'tournament.err.generic'
      );
    } finally {
      sending.current = false;
      setSaving(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('tournament.room.title')}>
      <Text style={styles.note}>{t('tournament.room.sheetNote')}</Text>
      {error && <ErrorBanner message={t(error)} />}
      <TextField
        label={t('tournament.room.id')}
        value={roomId}
        onChangeText={setRoomId}
        placeholder={t('tournament.room.idPlaceholder')}
        maxLength={ROOM_MAX}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
      />
      <TextField
        label={t('tournament.room.password')}
        value={password}
        onChangeText={setPassword}
        placeholder={t('tournament.room.passwordPlaceholder')}
        maxLength={ROOM_MAX}
        autoCapitalize="none"
        autoCorrect={false}
        // A game room's password, shown to players on purpose: not a secure field, and never offered to a password
        // manager as an account password.
        autoComplete="off"
        textContentType="none"
      />
      <Text style={styles.notify}>{t('tournament.room.confirmBody')}</Text>
      <Button
        label={tournament.room ? t('tournament.room.edit') : t('tournament.room.post')}
        icon="send"
        onPress={post}
        loading={saving}
        style={styles.save}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  note: { marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
  notify: { marginTop: -spacing.xs, fontFamily: fonts.medium, fontSize: 13, color: colors.limeInk },
  save: { marginTop: spacing.sm + 2 },
});
