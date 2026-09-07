import type { Sql } from 'postgres';
export class PairingError extends Error {
  code: string;
  status: 400 | 403 | 404 | 410 | 429;
}
export function normalizeCode(code: unknown): string;
export function randomSecret(): string;
export function digest(value: string): Promise<string>;
export function limit(sql: Sql, key: string, maximum: number, seconds?: number): Promise<void>;
export function startPairing(
  sql: Sql,
  input: { origin: string; deviceName: string; mode?: 'cookie' | 'native' },
): Promise<{
  requestId: string;
  deviceSecret: string;
  userCode: string;
  expiresAt: string;
  interval: number;
  verificationUri: string;
  verificationUriComplete: string;
}>;
export function previewPairing(
  sql: Sql,
  code: string,
): Promise<{
  requestId: string;
  origin: string;
  deviceName: string;
  createdAt: string;
  expiresAt: string;
  status: string;
}>;
export function decidePairing(
  sql: Sql,
  input: { code: string; requestId: string; userId: string; approve: boolean },
): Promise<{ status: string }>;
export function exchangePairing(
  sql: Sql,
  input: { requestId: string; deviceSecret: string; origin: string; userAgent?: string },
): Promise<
  | { status: 'authorization_pending' | 'slow_down'; interval: number }
  | {
      status: 'authorized';
      mode: 'cookie' | 'native';
      session: { id: string; token: string; expires_at: string };
    }
>;
