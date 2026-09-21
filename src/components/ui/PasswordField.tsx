import { useState, type ComponentProps } from 'react';
import { Pressable } from 'react-native';

import { EyeIcon, EyeOffIcon } from '../art/Icons';
import { TextField } from './TextField';
import { useT } from '../../lib/i18n';
import { colors } from '../../lib/theme';

type Props = Omit<ComponentProps<typeof TextField>, 'right' | 'secureTextEntry'>;

/** TextField with a show/hide eye toggle. */
export function PasswordField(props: Props) {
  const t = useT();
  const [visible, setVisible] = useState(false);

  return (
    <TextField
      {...props}
      autoCapitalize="none"
      secureTextEntry={!visible}
      right={
        <Pressable
          onPress={() => setVisible((v) => !v)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        >
          {visible ? (
            <EyeIcon color={colors.textFaint} />
          ) : (
            <EyeOffIcon color={colors.textFaint} />
          )}
        </Pressable>
      }
    />
  );
}
