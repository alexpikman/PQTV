import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

interface CertCache {
  certs: Record<string, string>;
  expiresAt: number;
}

let certCache: CertCache | null = null;

function getFirebaseProjectId(): string {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  return String(raw.projectId || '');
}

async function fetchGoogleCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (certCache && now < certCache.expiresAt) {
    return certCache.certs;
  }
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    throw new Error('Failed to fetch Google public certificates');
  }
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 3600 * 1000;
  const certs = (await res.json()) as Record<string, string>;
  certCache = { certs, expiresAt: now + maxAgeMs };
  return certs;
}

function decodeBase64Url(input: string): Buffer {
  const norm = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  return Buffer.from(norm + pad, 'base64');
}

export interface VerifiedFirebaseToken {
  uid: string;
  email: string;
  email_verified: boolean;
  name: string;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decodeBase64Url(headerB64).toString('utf-8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf-8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported token algorithm or missing kid');
  }

  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw new Error('Missing Firebase projectId');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('Invalid token audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Invalid token issuer');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Invalid token subject');
  }
  if (!payload.exp || payload.exp <= nowSec) {
    throw new Error('Token expired');
  }
  if (!payload.iat || payload.iat > nowSec + 300) {
    throw new Error('Token issued in the future');
  }

  const certs = await fetchGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) {
    throw new Error('Unknown signing key id');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const valid = verifier.verify(pem, decodeBase64Url(sigB64));
  if (!valid) {
    throw new Error('Invalid token signature');
  }

  return {
    uid: payload.sub,
    email: String(payload.email || ''),
    email_verified: Boolean(payload.email_verified),
    name: String(payload.name || ''),
  };
}
