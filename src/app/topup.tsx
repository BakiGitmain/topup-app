import { Redirect } from 'expo-router';

/** Kept so old links still work: adding balance is the Deposit screen now (Telebirr / CBE, verified automatically). */
export default function TopUpScreen() {
  return <Redirect href="/deposit" />;
}
