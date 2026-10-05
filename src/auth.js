// Sign-in = SIWE message from /auth/nonce, signed by the wallet, then /auth/verify.
// The site normally attaches a Cloudflare Turnstile token. We never solve it:
// if the server insists on one, the user signs in once in a real browser and
// pastes the session cookie instead (/cookie).

export class CaptchaRequired extends Error {
  constructor(msg) {
    super(msg || 'Server minta captcha.');
    this.code = 'captcha_required';
  }
}

export function checkSiweMessage(message, address, chainId) {
  const m = String(message || '');
  if (!m.startsWith('lootmarch.xyz wants you to sign in')) throw new Error('Pesan login tidak dikenal, batal tanda tangan.');
  if (!m.toLowerCase().includes(address.toLowerCase())) throw new Error('Pesan login bukan untuk wallet ini.');
  if (!m.includes('Chain ID: ' + chainId)) throw new Error('Chain ID pesan login tidak cocok.');
  if (!m.includes('URI: https://lootmarch.xyz')) throw new Error('URI pesan login tidak cocok.');
  return true;
}

export async function signInWithKey(api, wallet, chainId) {
  const address = wallet.address.toLowerCase();
  const { message } = await api.nonce(address);
  checkSiweMessage(message, address, chainId);
  const signature = await wallet.signMessage(message);
  try {
    const res = await api.verify({ address, signature, hint: null, captcha: null });
    return { address: res.address, created: !!res.created };
  } catch (e) {
    const text = `${e.code} ${e.message}`.toLowerCase();
    if (/captcha|turnstile|anti-bot|bot check/.test(text)) throw new CaptchaRequired(e.message);
    throw e;
  }
}
