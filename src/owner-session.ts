import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthConfig } from './oauth-provider.js';

export interface OwnerSession { issuedAt: number; expiresAt: number; value: string }
const signature = (key: string, value: string) => createHmac('sha256', key).update(value).digest('base64url');
const cookieName = (origin: string) => origin.startsWith('https:') ? '__Host-devspace-owner' : 'devspace_owner';
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function readOwnerSession(req: Pick<Request, 'headers'>, config: OAuthConfig, origin: string, now = Date.now()): OwnerSession | undefined {
  const ttl = config.ownerSessionTtlSeconds;
  if (!ttl) return undefined;
  const prefix = cookieName(origin) + '=';
  const value = req.headers?.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
  const parts = value?.split('.');
  if (!value || parts?.length !== 4 || parts[0] !== 'v1' || !/^\d+$/.test(parts[1]!) || !/^[\w-]{22}$/.test(parts[2]!)) return undefined;
  const issuedAt = Number(parts[1]), seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > seconds || issuedAt + ttl <= seconds ||
      !equal(parts[3]!, signature(config.ownerToken, `owner-session:${origin}:${parts.slice(0, 3).join('.')}`))) return undefined;
  return { issuedAt, expiresAt: issuedAt + ttl, value };
}
export function establishOwnerSession(res: Pick<Response, 'cookie'>, config: OAuthConfig, origin: string, now = Date.now()): OwnerSession | undefined {
  const ttl = config.ownerSessionTtlSeconds;
  if (!ttl) return undefined;
  const issuedAt = Math.floor(now / 1000);
  const body = `v1.${issuedAt}.${randomBytes(16).toString('base64url')}`;
  const value = `${body}.${signature(config.ownerToken, `owner-session:${origin}:${body}`)}`;
  res.cookie(cookieName(origin), value, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: ttl * 1000 });
  return { issuedAt, expiresAt: issuedAt + ttl, value };
}
export function ownerSessionFormProof(session: OwnerSession, fields: Record<string, string | undefined>, config: OAuthConfig): string {
  const canonical = JSON.stringify(Object.entries(fields).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return signature(config.ownerToken, `owner-consent:${session.value}:${canonical}`);
}
export function ownerSessionFormValid(proof: string, session: OwnerSession, fields: Record<string, string | undefined>, config: OAuthConfig): boolean {
  return equal(proof, ownerSessionFormProof(session, fields, config));
}
