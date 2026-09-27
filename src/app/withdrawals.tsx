import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../components/art/FeatherIcon';
import { StateMessage } from '../components/market/StateMessage';
import { Button } from '../components/ui/Button';
import { Chips, type ChipOption } from '../components/ui/Chips';
import { CopyButton } from '../components/ui/CopyButton';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { formatBirr } from '../lib/catalog';
import { confirmDestructive } from '../lib/confirm';
import { formatDateTime } from '../lib/format';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useToast } from '../lib/toast';
import { useAsync, useRefreshOnFocus } from '../lib/useAsync';
import { fetchPendingWithdrawals, fetchResolvedWithdrawals, resolveErrorText, resolveWithdrawal, type Withdrawal } from '../lib/wallet';

type Tab = 'pending' | 'history';

/**
 * Admin: withdrawal requests. The amount was already taken out of the customer's balance when they asked. You send the
 * money yourself (Telebirr / CBE app), then tap "I sent it" to mark it paid. "Decline" returns the exact held amount to their
 * balance and shows them your reason. English only, like the other admin screens.
 */
export default function WithdrawalsScreen() {
  const { session, isAdmin, initializing } = useAuth();
  const insets = useSafeAreaInsets();
  const allowed = !initializing && !!session && isAdmin;
  const [tab, setTab] = useState<Tab>('pending');
  const [refreshing, setRefreshing] = useState(false);

  const pending = useAsync(fetchPendingWithdrawals, 'pending', allowed);
  const history = useAsync(fetchResolvedWithdrawals, 'history', allowed);
  useRefreshOnFocus(() => {
    if (allowed) {
      pending.reload();
      history.reload();
    }
  });

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  const list = tab === 'pending' ? pending : history;
  const rows = list.data ?? [];
  const options: ChipOption<Tab>[] = [
    { id: 'pending', label: 'Pending', count: pending.data?.length },
    { id: 'history', label: 'History' },
  ];

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([pending.reload(), history.reload()]);
    setRefreshing(false);
  }

  function changed() {
    pending.reload();
    history.reload();
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.limeDeep} />}
      >
        <Column>
          <ScreenHeader title="Withdrawals" />
          <Chips options={options} value={tab} onChange={setTab} />

          {list.status === 'loading' && !list.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {list.status === 'error' && !list.data && (
            <StateMessage
              tone="danger"
              icon={<FeatherIcon name="alert-triangle" size={30} color={colors.danger} />}
              title="Couldn't load withdrawals"
              body="Check your connection, then try again."
              actionLabel="Try again"
              onAction={list.reload}
            />
          )}

          {list.data && rows.length === 0 && (
            <StateMessage
              icon={<FeatherIcon name="check-circle" size={30} color={colors.limeInk} />}
              title={tab === 'pending' ? 'All caught up' : 'Nothing here yet'}
              body={tab === 'pending' ? 'No withdrawals are waiting. New ones also arrive on Telegram.' : 'Handled requests show up here.'}
              actionLabel="Refresh"
              actionVariant="outline"
              onAction={list.reload}
            />
          )}

          {rows.map((w) => (w.status === 'pending' ? <PendingCard key={w.id} w={w} onChanged={changed} /> : <DoneRow key={w.id} w={w} />))}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const providerName = (p: string) => (p === 'telebirr' ? 'Telebirr' : 'CBE');

function PendingCard({ w, onChanged }: { w: Withdrawal; onChanged: () => void }) {
  const toast = useToast();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'paid' | 'declined' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function markPaid() {
    const ok = await confirmDestructive(
      'Mark as paid?',
      `Only do this after you have sent ${formatBirr(w.amount)} to ${providerName(w.provider)} ${w.account}. It cannot be undone.`,
      'I sent it',
      'primary'
    );
    if (!ok) return;
    setBusy('paid');
    setError(null);
    try {
      await resolveWithdrawal(w.id, true, '');
      toast('Marked as paid');
      onChanged();
    } catch (err) {
      setError(resolveErrorText(err));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function decline() {
    if (reason.trim() === '') return setError(resolveErrorText({ message: 'note_required' }));
    const ok = await confirmDestructive('Decline and refund?', `${formatBirr(w.amount)} goes back to the customer's balance, with your reason.`, 'Decline');
    if (!ok) return;
    setBusy('declined');
    setError(null);
    try {
      await resolveWithdrawal(w.id, false, reason);
      toast('Declined and refunded');
      onChanged();
    } catch (err) {
      setError(resolveErrorText(err));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.who}>
          <Text style={styles.name} numberOfLines={1}>
            {w.customer?.name ?? 'Customer'}
          </Text>
          {w.customer?.email ? (
            <Text style={styles.email} numberOfLines={1}>
              {w.customer.email}
            </Text>
          ) : null}
        </View>
        <Text style={styles.amount}>{formatBirr(w.amount)}</Text>
      </View>

      <View style={styles.sendTo}>
        <Text style={styles.sendLabel}>SEND TO</Text>
        <View style={styles.sendRow}>
          <Text style={styles.sendValue} selectable>
            {providerName(w.provider)}  {w.account}
          </Text>
          <CopyButton value={w.account} accessibilityLabel={`Copy ${w.account}`} />
        </View>
      </View>
      <Text style={styles.time}>Requested {formatDateTime(w.createdAt)}. The amount is already held.</Text>

      {declining && (
        <View style={styles.reasonBox}>
          <TextField label="Reason (the customer will see this)" value={reason} onChangeText={(v) => { setReason(v); setError(null); }} maxLength={200} />
        </View>
      )}

      {error && <ErrorBanner message={error} />}

      {declining ? (
        <View style={styles.buttons}>
          <Button label="Decline and refund" onPress={decline} loading={busy === 'declined'} disabled={busy !== null} style={styles.flex} />
          <Button label="Back" variant="outline" onPress={() => { setDeclining(false); setError(null); }} disabled={busy !== null} style={styles.flex} />
        </View>
      ) : (
        <View style={styles.buttons}>
          <Button label="I sent it" onPress={markPaid} loading={busy === 'paid'} disabled={busy !== null} style={styles.flex} />
          <Button label="Decline…" variant="outline" onPress={() => setDeclining(true)} disabled={busy !== null} style={styles.flex} />
        </View>
      )}
    </View>
  );
}

function DoneRow({ w }: { w: Withdrawal }) {
  const paid = w.status === 'paid' || w.status === 'approved';
  return (
    <View style={styles.doneRow}>
      <View style={styles.who}>
        <Text style={styles.name} numberOfLines={1}>
          {w.customer?.name ?? 'Customer'} · {formatBirr(w.amount)}
        </Text>
        <Text style={styles.email} numberOfLines={1}>
          {providerName(w.provider)} {w.account} · {formatDateTime(w.createdAt)}
        </Text>
        {w.adminNote ? <Text style={styles.email}>Note: {w.adminNote}</Text> : null}
      </View>
      <View style={[styles.pill, paid ? styles.pillOk : styles.pillBad]}>
        <Text style={[styles.pillText, paid ? styles.pillTextOk : styles.pillTextBad]}>{paid ? 'Paid' : 'Declined'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.xxl },
  card: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  who: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  email: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  amount: { fontFamily: fonts.extrabold, fontSize: 20, color: colors.text, letterSpacing: -0.4 },
  sendTo: { padding: spacing.sm + 2, borderRadius: radius.md, backgroundColor: colors.bgTint },
  sendLabel: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.8, color: colors.limeInk },
  sendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginTop: 2 },
  sendValue: { flex: 1, fontFamily: fonts.extrabold, fontSize: 17, color: colors.text },
  time: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  reasonBox: { marginTop: spacing.xs },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  flex: { flex: 1 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm + 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  pillOk: { backgroundColor: colors.limeSoft },
  pillBad: { backgroundColor: colors.dangerBg },
  pillText: { fontFamily: fonts.bold, fontSize: 12 },
  pillTextOk: { color: colors.limeDark },
  pillTextBad: { color: colors.danger },
});
