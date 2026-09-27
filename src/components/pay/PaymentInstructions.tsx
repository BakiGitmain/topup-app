import { StyleSheet, Text, View } from 'react-native';

import type { PaymentAccount } from '../../lib/checkout';
import { useT } from '../../lib/i18n';
import { cleanReference, type ProviderId } from '../../lib/paymentView';
import { fetchTutorials } from '../../lib/paymentTutorials';
import { forProvider } from '../../lib/tutorialEdit';
import { useAsync } from '../../lib/useAsync';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { ErrorBanner } from '../ui/ErrorBanner';
import { PasteButton } from '../ui/PasteButton';
import { ProviderPicker } from './ProviderPicker';
import { TutorialCarousel } from './TutorialCarousel';
import { TextField } from '../ui/TextField';

type Props = {
  /** The active receiving accounts (null until loaded). */
  accounts: PaymentAccount[] | null;
  accountsLoading: boolean;
  provider: ProviderId;
  onProvider: (provider: ProviderId) => void;
  reference: string;
  onReference: (text: string) => void;
  busy: boolean;
  message: string | null;
  onSubmit: () => void;
};

/**
 * "Send the money here, then enter the reference": the provider choice, the receiving account with a copy button, the
 * reference field with paste, and the submit button. Used by BOTH the checkout payment screen and the wallet deposit
 * screen, so the two behave and look the same. It holds no payment logic: the screen decides what submit does.
 */
export function PaymentInstructions({ accounts, accountsLoading, provider, onProvider, reference, onReference, busy, message, onSubmit }: Props) {
  const t = useT();
  // The admin's "how to pay" pictures for the chosen method. None uploaded (or not loaded yet) = nothing is drawn.
  const tutorials = useAsync(fetchTutorials);
  const account = accounts?.find((a) => a.provider === provider) ?? null;
  const cleaned = cleanReference(reference);

  return (
    <>
      <Text style={styles.section}>{t('pay.method')}</Text>
      <ProviderPicker label={t('pay.method')} value={provider} onChange={onProvider} />

      <TutorialCarousel key={provider} images={forProvider(tutorials.data ?? [], provider)} />

      <View style={styles.account}>
        {account ? (
          <>
            <Text style={styles.accountLabel}>{t('pay.accountName')}</Text>
            <Text style={styles.accountName}>{account.accountName}</Text>
            <Text style={[styles.accountLabel, styles.gap]}>{t('pay.accountNumber')}</Text>
            <View style={styles.numberRow}>
              <Text style={styles.number} selectable accessibilityLabel={`${t('pay.accountNumber')} ${account.accountNumber}`}>
                {account.accountNumber}
              </Text>
              <CopyButton value={account.accountNumber} accessibilityLabel={`${t('common.copy')} ${t('pay.accountNumber')}`} variant="label" />
            </View>
            <Text style={styles.steps}>{t(provider === 'telebirr' ? 'pay.steps.telebirr' : 'pay.steps.cbe')}</Text>
          </>
        ) : (
          <Text style={styles.noAccount}>{accountsLoading ? '…' : t('pay.noAccount')}</Text>
        )}
      </View>

      <TextField
        label={t(provider === 'telebirr' ? 'pay.ref.telebirr' : 'pay.ref.cbe')}
        value={reference}
        onChangeText={onReference}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        editable={!busy}
        right={<PasteButton onPaste={onReference} />}
      />
      <Text style={styles.hint}>{t(provider === 'telebirr' ? 'pay.refHint.telebirr' : 'pay.refHint.cbe')}</Text>

      {message && <ErrorBanner message={message} />}

      <Button label={busy ? t('pay.verifying') : t('pay.submit')} onPress={onSubmit} loading={busy} disabled={!account || cleaned === null} />
    </>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md, marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  account: { marginTop: spacing.md, marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  accountLabel: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  gap: { marginTop: spacing.sm },
  accountName: { marginTop: 2, fontFamily: fonts.bold, fontSize: 17, color: colors.text },
  numberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginTop: 2 },
  number: { flex: 1, fontFamily: fonts.extrabold, fontSize: 21, color: colors.text, letterSpacing: 0.5 },
  steps: { marginTop: spacing.sm, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 20, color: colors.textMuted },
  noAccount: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.danger },
  hint: { marginTop: -spacing.sm, marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
});
