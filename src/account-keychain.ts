import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { bt } from './i18n.js';
import {
  credDelete,
  credRead,
  credWrite,
  isWindows,
  Win32HelperError,
  type Win32HelperOptions,
} from './platform/index.js';

const execFileAsync = promisify(execFile);

export type KeychainPayloadEncoding = 'go-keyring-base64' | 'raw';

export interface KeychainAdapter {
  readonly payloadEncoding?: KeychainPayloadEncoding;
  readPassword(service: string, account: string): Promise<string | null>;
  writePassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

/**
 * Windows Credential Manager adapter backed by `gravitybox-win-helper.exe`.
 * Uses raw UTF-8 payload bytes to match `zalando/go-keyring/keyring_windows.go`.
 */
export class WindowsCredentialManagerAdapter implements KeychainAdapter {
  readonly payloadEncoding: KeychainPayloadEncoding = 'raw';

  constructor(private readonly options?: Win32HelperOptions) {}

  async readPassword(service: string, account: string): Promise<string | null> {
    try {
      const value = await credRead(service, account, this.options);
      return value && value.length > 0 ? value : null;
    } catch {
      throw new Error(bt('keychain.err.read'));
    }
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    try {
      await credWrite(service, account, password, this.options);
    } catch (error) {
      if (error instanceof Win32HelperError && error.code === 'HELPER_TIMEOUT') {
        throw new Error(bt('keychain.err.write_timeout'));
      }
      throw new Error(bt('keychain.err.write'));
    }
  }

  async deletePassword(service: string, account: string): Promise<void> {
    try {
      await credDelete(service, account, this.options);
    } catch {
      throw new Error(bt('keychain.err.delete'));
    }
  }
}

export class SystemKeychainAdapter implements KeychainAdapter {
  private readonly windowsAdapter: WindowsCredentialManagerAdapter | null;
  readonly payloadEncoding: KeychainPayloadEncoding;

  constructor(options?: Win32HelperOptions) {
    if (isWindows()) {
      this.windowsAdapter = new WindowsCredentialManagerAdapter(options);
      this.payloadEncoding = 'raw';
    } else {
      this.windowsAdapter = null;
      this.payloadEncoding = 'go-keyring-base64';
    }
  }

  async readPassword(service: string, account: string): Promise<string | null> {
    if (this.windowsAdapter) {
      return this.windowsAdapter.readPassword(service, account);
    }
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ], { timeout: 5000 });
      return stdout.trim() || null;
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null;
      throw new Error(bt('keychain.err.read'));
    }
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    if (this.windowsAdapter) {
      return this.windowsAdapter.writePassword(service, account, password);
    }
    return new Promise((resolve, reject) => {
      const q = (val: string) => `"${String(val).replace(/[\\"\r\n]/g, m => (m === '\r' || m === '\n' ? '' : `\\${m}`))}"`;
      // 通过 security -i 批处理从 stdin 传入完整命令与密码，既不在 argv 暴露凭据，也不触发 /dev/tty getpass() 阻塞
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(new Error(bt('keychain.err.write_timeout')));
      }, 5000);

      child.stdin.on('error', () => {});
      child.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(account)} -w ${q(password)}\n`);

      child.stderr.on('data', () => {});
      child.on('close', code => {
        if (code === 0) finish();
        else finish(new Error(bt('keychain.err.write')));
      });
      child.on('error', () => {
        finish(new Error(bt('keychain.err.write')));
      });
    });
  }

  async deletePassword(service: string, account: string): Promise<void> {
    if (this.windowsAdapter) {
      return this.windowsAdapter.deletePassword(service, account);
    }
    try {
      await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 5000 });
    } catch (error) { if ((error as { code?: number }).code !== 44) throw new Error(bt('keychain.err.delete')); }
  }
}

export class MockKeychainAdapter implements KeychainAdapter {
  private store = new Map<string, string>();
  readonly payloadEncoding: KeychainPayloadEncoding;

  constructor(options?: { payloadEncoding?: KeychainPayloadEncoding }) {
    this.payloadEncoding = options?.payloadEncoding ?? 'go-keyring-base64';
  }

  async readPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(`${service}:${account}`) ?? null;
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    this.store.set(`${service}:${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<void> {
    this.store.delete(`${service}:${account}`);
  }
}

export interface KeychainSyncAccount {
  email: string;
  token: {
    access_token: string;
    token_type?: string;
    refresh_token: string;
    expiry_timestamp: number;
    expires_in?: number;
    project_id?: string | null;
    is_gcp_tos?: boolean;
    id_token?: string | null;
  };
}

/**
 * 构造官方 Go 端 (macOS Keychain & agy CLI) 通用 oauth2.Token JSON 载荷
 */
export function buildGoOauthPayload(acc: KeychainSyncAccount): string {
  // 官方 Go 端按 oauth2.Token 解析：缺少 `expiry` 会被视为永不过期，从而永不刷新（约 1 小时后 401 并跳登录页）。
  // 因此必须写入 RFC3339 `expiry`；旧字段保留供 GravityBox 自身读取与回滚。
  const expirySec = Number(acc.token.expiry_timestamp);
  const expiry = Number.isFinite(expirySec) && expirySec > 0 ? new Date(expirySec * 1000).toISOString() : new Date(0).toISOString();
  const expiresIn = expirySec > 0 ? Math.max(0, Math.floor(expirySec - Date.now() / 1000)) : (acc.token.expires_in ?? 0);
  const accessToken = acc.token.access_token && acc.token.access_token !== 'pending_refresh' ? acc.token.access_token : '';
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: acc.token.token_type || 'Bearer',
      refresh_token: acc.token.refresh_token,
      expiry,
      expires_in: expiresIn,
      expiry_timestamp: Number.isFinite(expirySec) && expirySec > 0 ? expirySec : 0,
      email: acc.email,
      project_id: acc.token.project_id,
      is_gcp_tos: acc.token.is_gcp_tos,
      id_token: acc.token.id_token,
    },
    ...(acc.token.is_gcp_tos ? {} : { auth_method: 'consumer' }),
    id_token_email: acc.email,
  });
}

/**
 * 解码系统凭据库中读取的 OAuth JSON 载荷：
 * - macOS `go-keyring` 使用 `go-keyring-base64:<base64>` 包装；
 * - Windows `go-keyring` 直接存储原始 UTF-8 JSON `{...}`。
 */
export function decodeKeychainOauthPayload(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('go-keyring-base64:')) {
    try {
      return Buffer.from(trimmed.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('{')) {
    return trimmed;
  }
  return null;
}

export function encodeKeychainOauthPayload(
  acc: KeychainSyncAccount,
  encoding: KeychainPayloadEncoding = isWindows() ? 'raw' : 'go-keyring-base64',
): string {
  const payload = buildGoOauthPayload(acc);
  if (encoding === 'raw') return payload;
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return `go-keyring-base64:${b64}`;
}

/**
 * 将指定账号写入系统凭据库 (gemini/antigravity) 免密持久化
 */
export async function syncAccountToKeychain(
  acc: KeychainSyncAccount,
  keychain: KeychainAdapter = new SystemKeychainAdapter()
): Promise<void> {
  const encoding: KeychainPayloadEncoding = keychain.payloadEncoding ?? 'go-keyring-base64';
  await keychain.writePassword('gemini', 'antigravity', encodeKeychainOauthPayload(acc, encoding));
}
