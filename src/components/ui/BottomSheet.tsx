import { useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, spacing } from '../../lib/theme';
import { useReducedMotion } from '../../lib/useReducedMotion';

type Props = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

const OFFSCREEN = 600;

/** Slide-up sheet that scrolls when its content (or the keyboard) needs the room. */
export function BottomSheet({ visible, onClose, title, children }: Props) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [slide] = useState(() => new Animated.Value(OFFSCREEN));

  useEffect(() => {
    if (!visible) {
      slide.setValue(OFFSCREEN);
      return;
    }
    if (reduced) {
      slide.setValue(0);
      return;
    }
    Animated.timing(slide, {
      toValue: 0,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, reduced, slide]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <Animated.View
          style={[
            styles.sheet,
            { maxHeight: height * 0.9, transform: [{ translateY: slide }] },
          ]}
        >
          <View style={styles.grabber} />
          {title ? <Text style={styles.title}>{title}</Text> : null}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(20, 26, 18, 0.45)',
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm + 2,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    backgroundColor: colors.bg,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.extrabold,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: spacing.md,
  },
});
