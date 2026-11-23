import session from 'express-session';
import { pool } from './database.js';

type SessionCallback = (error: any, value?: session.SessionData | null) => void;

export class PostgresSessionStore extends session.Store {
  private writesSinceCleanup = 0;

  get(sid: string, callback: SessionCallback): void {
    void pool.query('SELECT sess FROM pqtv_sessions WHERE sid = $1 AND expire > NOW()', [sid])
      .then((result) => callback(null, (result.rows[0]?.sess as session.SessionData | undefined) || null))
      .catch(callback);
  }

  set(sid: string, value: session.SessionData, callback?: (error?: any) => void): void {
    const maxAge = Number(value.cookie?.maxAge) || 30 * 24 * 60 * 60 * 1000;
    const expires = value.cookie?.expires ? new Date(value.cookie.expires.getTime()) : new Date(Date.now() + maxAge);
    void pool.query(
      'INSERT INTO pqtv_sessions (sid, sess, expire) VALUES ($1, $2::json, $3) ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire',
      [sid, JSON.stringify(value), expires]
    ).then(async () => {
      this.writesSinceCleanup++;
      if (this.writesSinceCleanup >= 100) {
        this.writesSinceCleanup = 0;
        await pool.query('DELETE FROM pqtv_sessions WHERE expire < NOW()');
      }
      callback?.();
    }).catch((error) => callback?.(error));
  }

  touch(sid: string, value: session.SessionData, callback?: (error?: any) => void): void {
    const maxAge = Number(value.cookie?.maxAge) || 30 * 24 * 60 * 60 * 1000;
    const expires = value.cookie?.expires ? new Date(value.cookie.expires.getTime()) : new Date(Date.now() + maxAge);
    void pool.query('UPDATE pqtv_sessions SET expire = $2 WHERE sid = $1', [sid, expires])
      .then(() => callback?.()).catch((error) => callback?.(error));
  }

  destroy(sid: string, callback?: (error?: any) => void): void {
    void pool.query('DELETE FROM pqtv_sessions WHERE sid = $1', [sid])
      .then(() => callback?.()).catch((error) => callback?.(error));
  }
}
