import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import {
  adminErrorMessage,
  deliverOrder,
  setOrderStatus,
  type QueueOrder,
} from '../../lib/admin';
import { formatBirr } from '../../lib/catalog';
import { formatDateTime, shortWait } from '../../lib/format';
import { verificationOf } from '../../lib/orderView';
import { describeFields } from '../../lib/productView';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { FeatherIcon } from '../art/FeatherIcon';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/ErrorBanner';
import { STATUS_LABELS_EN, StatusBadge } from '../ui/StatusBadge';
import { OrderTrail } from './OrderTrail';

type Props = {
  order: QueueOrder | null;
  onClose: () => void;
  /** Called after any change, so the lists can refresh. */
  onChanged: () => void;
};

type Confirm = 'failed' | 'refunded' | null;

/**
 * Work one order: copy the game ID, paste the code, then deliver it or fail
 * it (which refunds the customer). Everything is enforced by the database, so
 * a double tap or a stale screen just gets a clear error.
 */
export function OrderSheet({ order, onClose, onChanged }: Props) {
  return (
    <BottomSheet visible={!!order} onClose={onClose} title={order?.product_name}>
      {order ? <SheetBody key={order.id} order={order} onClose={onClose} onChanged={onChanged} /> : null}
    </BottomSheet>
  );
}

function SheetBody({
  order,
  onClose,
  onChanged,
}: {
  order: QueueOrder;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const open = order.status === 'pending' || order.status === 'processing';
  const needsCode = order.fulfillment === 'code';
  const fields = describeFields(order.delivery);
  const verification = verificationOf(order);
  const canRefundCompleted = order.status === 'completed' && order.fulfillment === 'topup';

  async function run(action: () => Promise<void>, doneMessage: string) {
    setError(null);
    setBusy(true);
    try {
      await action();
      toast(doneMessage);
      onChanged();
      onClose();
    } catch (err) {
      setError(adminErrorMessage(err));
      onChanged(); // the order may have changed under us: refresh the list
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function copyField(label: string, value: string) {
    await Clipboard.setStringAsync(value);
    toast(`${label} copied`);
  }

  async function pasteCode() {
    setCode((await Clipboard.getStringAsync()).trim());
  }

  return (
    <View>
      <View style={styles.statusRow}>
        <StatusBadge status={order.status} label={STATUS_LABELS_EN[order.status]} />
        <Text style={styles.amount}>{formatBirr(order.amount)}</Text>
      </View>

      <Text style={styles.line}>{order.option_label}</Text>
      <Text style={styles.meta}>
        {order.customerName}
        {order.customerEmail && order.customerEmail !== order.customerName
          ? ` · ${order.customerEmail}`
          : ''}
      </Text>
      <Text style={styles.meta}>
        {formatDateTime(order.created_at)}
        {open ? ` · waiting ${shortWait(order.created_at)}` : ''}
      </Text>

      {order.region_label ? <Text style={styles.meta}>Region: {order.region_label}</Text> : null}

      {fields.map(([label, value]) => (
        <View key={label} style={styles.idCard}>
          <Text style={styles.idLabel}>{label}</Text>
          <Text style={styles.idValue} selectable>
            {value}
          </Text>
          <Button label={`Copy ${label}`} onPress={() => copyField(label, value)} style={styles.copy} />
        </View>
      ))}

      {/* The order's whole trail: payment (method, reference, what ShegerPay verified) and delivery. */}
      <OrderTrail order={order} />

      {fields.length > 0 ? (
        <View style={styles.idCard}>
          <Text style={styles.idLabel}>What was checked at purchase</Text>
          {verification.kind === 'validated' ? (
            <>
              <Text style={styles.meta}>Verified with the game before ordering.</Text>
              {verification.playerName ? <Text style={styles.meta} selectable>Player: {verification.playerName}</Text> : null}
              <Text style={styles.meta}>Account region: {verification.accountRegion ?? 'not reported'}</Text>
              <Text style={styles.meta} selectable>Record: {verification.recordId}</Text>
            </>
          ) : verification.kind === 'self_declared' ? (
            <Text style={styles.meta}>
              Not verified. The customer ticked “I’ve checked my ID” at {formatDateTime(verification.at)}.
            </Text>
          ) : (
            <Text style={styles.meta}>Not checked (placed before ID checks, or nothing to check).</Text>
          )}
        </View>
      ) : null}

      {open && needsCode ? (
        <View style={styles.codeCard}>
          <Text style={styles.idLabel}>Code to deliver</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Paste the gift card / key here"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            style={styles.codeInput}
            accessibilityLabel="Code to deliver"
          />
          <Button label="Paste from clipboard" variant="outline" onPress={pasteCode} />
        </View>
      ) : null}

      {order.status === 'completed' && needsCode ? (
        <View style={styles.note}>
          <FeatherIcon name="key" size={16} color={colors.limeDark} />
          <Text style={styles.noteText}>
            The code was delivered to the customer&apos;s Vault. It can&apos;t be refunded.
          </Text>
        </View>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {open ? (
        <View style={styles.actions}>
          {order.status === 'pending' ? (
            <Button
              label="Start processing"
              variant="outline"
              disabled={busy}
              onPress={() =>
                run(() => setOrderStatus(order.id, 'processing'), 'Marked as processing')
              }
            />
          ) : null}
          <Button
            label="Mark delivered"
            loading={busy && confirm === null}
            disabled={busy || (needsCode && code.trim().length === 0)}
            onPress={() => run(() => deliverOrder(order.id, needsCode ? code : null), 'Marked delivered')}
          />
          {confirm === 'failed' ? (
            <ConfirmPanel
              text={`Mark this order failed and return ${formatBirr(order.amount)} to the customer?`}
              yes="Yes, refund"
              busy={busy}
              onNo={() => setConfirm(null)}
              onYes={() =>
                run(() => setOrderStatus(order.id, 'failed'), `Refunded ${formatBirr(order.amount)}`)
              }
            />
          ) : (
            <Button
              label={`Mark failed and refund ${formatBirr(order.amount)}`}
              variant="outline"
              disabled={busy}
              onPress={() => setConfirm('failed')}
            />
          )}
        </View>
      ) : null}

      {canRefundCompleted ? (
        <View style={styles.actions}>
          {confirm === 'refunded' ? (
            <ConfirmPanel
              text={`Refund ${formatBirr(order.amount)} for this delivered order?`}
              yes="Yes, refund"
              busy={busy}
              onNo={() => setConfirm(null)}
              onYes={() =>
                run(() => setOrderStatus(order.id, 'refunded'), `Refunded ${formatBirr(order.amount)}`)
              }
            />
          ) : (
            <Button
              label={`Refund ${formatBirr(order.amount)}`}
              variant="outline"
              disabled={busy}
              onPress={() => setConfirm('refunded')}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

function ConfirmPanel({
  text,
  yes,
  busy,
  onNo,
  onYes,
}: {
  text: string;
  yes: string;
  busy: boolean;
  onNo: () => void;
  onYes: () => void;
}) {
  return (
    <View style={styles.confirm}>
      <Text style={styles.confirmText}>{text}</Text>
      <View style={styles.confirmButtons}>
        <View style={styles.half}>
          <Button label="Cancel" variant="outline" onPress={onNo} disabled={busy} />
        </View>
        <View style={styles.half}>
          <Button label={yes} variant="dark" onPress={onYes} loading={busy} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm + 2,
  },
  amount: { fontFamily: fonts.extrabold, fontSize: 24, color: colors.limeInk, letterSpacing: -0.6 },
  line: { fontFamily: fonts.bold, fontSize: 17, color: colors.text },
  meta: { marginTop: 3, fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },

  idCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.limeSoft,
  },
  idLabel: { fontFamily: fonts.semibold, fontSize: 12.5, color: '#5E7352' },
  idValue: {
    marginVertical: spacing.sm,
    fontFamily: fonts.extrabold,
    fontSize: 30,
    lineHeight: 38,
    letterSpacing: 1.2,
    color: colors.text,
  },
  copy: { marginTop: spacing.xs },

  codeCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    gap: spacing.sm + 2,
  },
  codeInput: {
    height: 52,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
  },

  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgTint,
  },
  noteText: { flex: 1, fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 19, color: colors.text },

  actions: { marginTop: spacing.md, gap: spacing.sm + 2 },
  confirm: {
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    gap: spacing.sm + 4,
  },
  confirmText: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 20, color: colors.text },
  confirmButtons: { flexDirection: 'row', gap: spacing.sm + 2 },
  half: { flex: 1 },
});
