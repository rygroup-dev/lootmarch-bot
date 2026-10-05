import { ethers } from 'ethers';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// Fallback token address; the game reports the live one in /game/deposit.
export const LM_TOKEN = '0xa5c8cc9fbe4b41b383edb70348d28dd287c63e18';

export function normalizeKey(input) {
  let k = String(input || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(k)) k = '0x' + k;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('Private key harus 64 karakter hex (boleh diawali 0x).');
  return k;
}

export function isAddress(a) {
  return ethers.isAddress(String(a || '').trim());
}

// Parse a human amount like "1,000.5" or "10k" into a decimal string.
export function parseAmount(input) {
  let s = String(input || '').trim().toLowerCase().replace(/[,_\s]/g, '');
  let mul = 1n;
  if (s.endsWith('k')) { mul = 1000n; s = s.slice(0, -1); } else if (s.endsWith('m')) { mul = 1000000n; s = s.slice(0, -1); }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Jumlah tidak valid.');
  if (mul === 1n) return s;
  const [i, f = ''] = s.split('.');
  const scaled = ethers.parseUnits(i + '.' + (f || '0'), 18) * mul;
  return ethers.formatUnits(scaled, 18).replace(/\.0$/, '');
}

export class WalletService {
  constructor({ rpcUrl, chainId, privateKey = null, provider = null }) {
    this.provider = provider || new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    this.chainId = chainId;
    this.signer = privateKey ? new ethers.Wallet(privateKey, this.provider) : null;
  }

  static create() {
    const w = ethers.Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  }

  static fromKey(key) {
    const w = new ethers.Wallet(normalizeKey(key));
    return { address: w.address, privateKey: w.privateKey };
  }

  get address() { return this.signer?.address || null; }

  requireSigner() {
    if (!this.signer) throw new Error('Wallet belum di-set. Buka 💰 Wallet → Import key.');
    return this.signer;
  }

  signMessage(message) { return this.requireSigner().signMessage(message); }

  async balances(token = LM_TOKEN, address = this.address) {
    const c = new ethers.Contract(token, ERC20, this.provider);
    const [eth, lm] = await Promise.all([this.provider.getBalance(address), c.balanceOf(address)]);
    return { eth, lm };
  }

  async sendEth(to, amountEth) {
    const s = this.requireSigner();
    return s.sendTransaction({ to: ethers.getAddress(to), value: ethers.parseEther(String(amountEth)) });
  }

  async sendWei(to, wei) {
    const s = this.requireSigner();
    return s.sendTransaction({ to: ethers.getAddress(to), value: BigInt(wei) });
  }

  async sendToken(token, to, amount, decimals = 18) {
    const s = this.requireSigner();
    const c = new ethers.Contract(token, ERC20, s);
    return c.transfer(ethers.getAddress(to), ethers.parseUnits(String(amount), decimals));
  }

  async wait(tx, confirmations = 1) {
    const r = await tx.wait(confirmations, 180000);
    if (!r || r.status !== 1) throw new Error('Transaksi gagal di chain: ' + tx.hash);
    return r;
  }
}

export const fmtEth = (wei, dp = 6) => trimNum(ethers.formatEther(wei), dp);
export const fmtUnits = (v, dec = 18, dp = 2) => trimNum(ethers.formatUnits(v, dec), dp);

function trimNum(s, dp) {
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, dp).replace(/0+$/, '');
  return Number(i).toLocaleString('en-US') + (frac ? '.' + frac : '');
}
