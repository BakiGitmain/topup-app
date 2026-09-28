import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon } from '../components/art/FeatherIcon';
import { TournamentCard } from '../components/tournament/TournamentCard';
import { gameLabel } from '../components/tournament/labels';
import { Button } from '../components/ui/Button';
import { Chips } from '../components/ui/Chips';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { PillGroup } from '../components/ui/PillGroup';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { GAMES, type Game } from '../lib/tournamentRules';
import { fetchTournaments, type ListScope } from '../lib/tournaments';
import { useAsync, useRefreshOnFocus } from '../lib/useAsync';
import { useNow } from '../lib/useNow';

type GameFilter = Game | 'all';

/** Profile > Tournaments: every open tournament (anyone), and the ones you host (content creators). */
export default function TournamentsScreen() {
  const { session, initializing, isContentCreator } = useAuth();
  const t = useT();
  const now = useNow();
  const [scope, setScope] = useState<ListScope>('open');
  const [game, setGame] = useState<GameFilter>('all');
  const [refreshing, setRefreshing] = useState(false);
  // A creator who stops being one must not be left on a tab they no longer have.
  const shownScope: ListScope = isContentCreator ? scope : 'open';

  const list = useAsync(() => fetchTournaments(shownScope, game === 'all' ? null : game), `${shownScope}|${game}`, !!session);
  useRefreshOnFocus(list.reload);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  async function onRefresh() {
    setRefreshing(true);
    await list.reload();
    setRefreshing(false);
  }

  const items = list.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.limeInk} />}
      >
        <Column>
          <ScreenHeader title={t('tournament.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/profile'))} />

          {isContentCreator && (
            <>
              <Button label={t('tournament.hostButton')} icon="plus" variant="dark" onPress={() => router.push('/tournament/host')} style={styles.host} />
              <PillGroup
                label={t('tournament.title')}
                options={[
                  { id: 'open', label: t('tournament.tab.open') },
                  { id: 'hosting', label: t('tournament.tab.hosting') },
                ]}
                value={scope}
                onChange={setScope}
              />
            </>
          )}

          <View style={styles.filters}>
            <Chips<GameFilter>
              options={[{ id: 'all', label: t('tournament.filter.all') }, ...GAMES.map((g) => ({ id: g, label: gameLabel(t, g) }))]}
              value={game}
              onChange={setGame}
            />
          </View>

          {list.status === 'error' && <ErrorBanner message={t('common.loadError')} />}
          {list.status === 'error' && !list.data && <Button label={t('common.retry')} variant="outline" onPress={list.reload} />}

          {list.status === 'loading' && !list.data ? (
            <ActivityIndicator color={colors.limeInk} style={styles.loading} />
          ) : list.data && items.length === 0 ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <FeatherIcon name="award" size={26} color={colors.limeDark} />
              </View>
              <Text style={styles.emptyTitle}>{shownScope === 'hosting' ? t('tournament.empty.hosting') : t('tournament.empty.open')}</Text>
              <Text style={styles.emptyBody}>{shownScope === 'hosting' ? t('tournament.empty.hostingBody') : t('tournament.empty.openBody')}</Text>
            </View>
          ) : (
            <View style={styles.list}>
              {items.map((item) => (
                <TournamentCard key={item.id} tournament={item} now={now} onPress={() => router.push({ pathname: '/tournament/[id]', params: { id: item.id } })} />
              ))}
            </View>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xl },
  host: { marginBottom: spacing.md },
  filters: { marginTop: spacing.sm, marginBottom: spacing.md },
  loading: { marginTop: spacing.xl },
  list: { gap: spacing.sm + 4 },
  empty: { alignItems: 'center', paddingVertical: spacing.xl, paddingHorizontal: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.surface },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft, marginBottom: spacing.md },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, textAlign: 'center' },
  emptyBody: { marginTop: 4, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
});
