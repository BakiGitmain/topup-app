// Sending one message to the admin's Telegram chat. Pure apart from the injected fetch, so Node can test it.
//
// Secrets (Supabase Edge Function secrets, set by the owner; never in code, never in the app):
//   TELEGRAM_BOT_TOKEN      from @BotFather, looks like 123456789:AAE...
//   TELEGRAM_ADMIN_CHAT_ID  the chat the bot writes to; a number (negative for a group)
//
// Messages are sent as PLAIN TEXT (no parse_mode): a customer's name or payout number can never inject formatting or links.
// The token never appears in an error, a log or a return value: failures come back as a short category only.

export type TelegramConfig = { token: string; chatId: string };

const TOKEN_SHAPE = /^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT_SHAPE = /^-?[0-9]{3,}$/;
const MAX_LEN = 4000; // Telegram's limit is 4096

/** The config, or null if either secret is missing or malformed (so a typo is reported, not silently sent nowhere). */
export function readTelegramConfig(token: string | undefined | null, chatId: string | undefined | null): TelegramConfig | null {
  const t = (token ?? '').trim();
  const c = (chatId ?? '').trim();
  return TOKEN_SHAPE.test(t) && CHAT_SHAPE.test(c) ? { token: t, chatId: c } : null;
}

/** Control characters out (newlines kept), length capped. */
export function cleanMessage(text: string): string {
  const cleaned = String(text ?? '').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  return cleaned.length > MAX_LEN ? `${cleaned.slice(0, MAX_LEN - 1)}…` : cleaned;
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** A short, safe reason: never the token, never Telegram's free text. */
export function errorCategory(status: number): string {
  if (status === 401) return 'http_401'; // wrong token
  if (status === 403) return 'http_403'; // the bot was blocked / removed from the chat
  if (status === 400) return 'http_400'; // e.g. chat not found: the bot never received a message from that chat
  if (status === 404) return 'http_404'; // token not recognised
  if (status === 429) return 'http_429'; // sending too fast
  return status >= 500 ? 'http_5xx' : `http_${status}`;
}

export async function sendTelegram(
  fetchFn: typeof fetch,
  config: TelegramConfig,
  text: string,
  timeoutMs = 8000,
): Promise<SendResult> {
  const body = cleanMessage(text);
  if (!body) return { ok: false, error: 'empty' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text: body, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: errorCategory(res.status) };
  } catch {
    // Network failure or timeout. (The thrown error is dropped on purpose: some runtimes put the URL, and so the token, in it.)
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
