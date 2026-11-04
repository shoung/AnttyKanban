import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { enforceUid } from './authPolicy.js';

export const allowedScopes = [
  'maps:read',
  'maps:write',
  'boards:read',
  'boards:write',
  'calendar:read',
  'calendar:write',
] as const;
export type McpScope = (typeof allowedScopes)[number];
export interface McpPrincipal {
  uid: string;
  scopes: McpScope[];
  tokenIssuedAt?: number;
}
export interface McpTokenRecord {
  ownerUid: string;
  name: string;
  scopes: McpScope[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  revokedAt?: number;
}
const scopesSchema = z
  .array(z.enum(allowedScopes))
  .min(1)
  .max(allowedScopes.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, 'Duplicate scopes');
const requestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: scopesSchema,
    days: z.number().int().min(1).max(90).default(30),
  })
  .strict();
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const generateToken = () => `antty_${randomBytes(32).toString('base64url')}`;
export function parseTokenRequest(value: unknown) {
  return requestSchema.parse(value);
}
export function authorizeToken(value: unknown, scope?: string, now = Date.now()): McpPrincipal {
  const record = value as Partial<McpTokenRecord> | null;
  const fail = (): never => {
    throw Object.assign(new Error('Invalid, expired, or revoked agent token'), { status: 401 });
  };
  if (!record) return fail();
  if (
    record.revoked !== false ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt! <= now
  )
    fail();
  const uid = enforceUid(record.ownerUid);
  const parsed = scopesSchema.safeParse(record.scopes);
  if (!parsed.success) fail();
  const scopes = parsed.data!;
  if (scope !== undefined && !scopes.includes(scope as McpScope))
    throw Object.assign(new Error('Agent token does not allow this operation'), { status: 403 });
  return { uid, scopes };
}

export function assertActiveMcpAccount(
  user: { disabled: boolean; tokensValidAfterTime?: string },
  issuedAt: number | undefined,
) {
  const validAfter =
    user.tokensValidAfterTime === undefined ? 0 : Date.parse(user.tokensValidAfterTime);
  if (
    user.disabled ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isFinite(validAfter) ||
    issuedAt! < validAfter
  ) {
    throw Object.assign(new Error('Agent token account access has been revoked'), { status: 401 });
  }
}
