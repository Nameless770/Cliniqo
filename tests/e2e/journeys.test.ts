import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appPool, closePools } from '../helpers/db';
import { BrowserSession, text } from './client';
import { seedCast, PASSWORD, type Cast } from './seed';
import { startApp, type RunningApp } from './server';

/**
 * End-to-end journeys.
 *
 * The layer nothing else in this suite covers. The integration tests call the audited
 * data layer directly with a synthetic session; these drive a REAL running server the way
 * a person does — through middleware, through the session cookie, through the server
 * action, into PostgreSQL, and back out as HTML that is then asserted on.
 *
 * That gap is not theoretical. Every bug this project has shipped and then found by hand
 * lived exactly there: an action nothing was wired to, a form whose fields never reached
 * the parser, a page that 500'd while its data layer was green. Each one typechecked, and
 * each one would have failed the journeys below.
 *
 * Everything runs without JavaScript, over Next's progressive-enhancement path — see
 * client.ts. So each journey doubles as a proof the application is usable with scripting
 * off, which for a clinic is worth having on purpose.
 */

let app: RunningApp;
let cast: Cast;

beforeAll(async () => {
  app = await startApp();
  cast = await seedCast();
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await closePools();
});

const visitor = () => new BrowserSession(app.baseUrl);

async function signIn(session: BrowserSession, path: string, email: string) {
  const page = await session.get(path);
  return session.submit(page, 'name="email"', { email, password: PASSWORD });
}

/* ------------------------------------------------------------------ the front door */

describe('the front door', () => {
  it('serves a home page offering both ways in', async () => {
    const page = await visitor().get('/');

    expect(page.status).toBe(200);
    const body = text(page.html);
    expect(body).toContain('patient');
    expect(page.html).toContain('/portal/login');
    expect(page.html).toContain('/login');
  });

  it('sets a Content-Security-Policy with a nonce on every page', async () => {
    const response = await visitor().head('/login');
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(csp).toMatch(/script-src [^;]*'nonce-/);
    expect(csp).toContain("'strict-dynamic'");
    // The control that bounds an XSS: no third-party origin can be reached.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sends an anonymous visitor from a staff page to sign-in', async () => {
    const page = await visitor().get('/dashboard');
    expect(page.url).toContain('/login');
    expect(text(page.html)).toContain('Sign in');
  });

  it('sends an anonymous visitor from the portal to the portal sign-in', async () => {
    const page = await visitor().get('/portal');
    expect(page.url).toContain('/portal/login');
  });
});

/* ------------------------------------------------------------------------- staff */

describe('staff sign-in and role boundaries', () => {
  it('refuses a wrong password and records the attempt', async () => {
    const session = visitor();
    const page = await session.get('/login');
    const result = await session.submit(page, 'name="email"', {
      email: cast.adminEmail,
      password: 'not-the-password',
    });

    expect(result.url).toContain('/login');
    expect(text(result.html)).toMatch(/invalid email or password/i);

    const audit = await appPool.query(
      `SELECT outcome FROM audit_event WHERE action = 'auth.login' AND outcome = 'denied'`,
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('signs an administrator in and hands them a hardened session cookie', async () => {
    const session = visitor();
    const page = await signIn(session, '/login', cast.adminEmail);

    expect(page.url).toContain('/dashboard');
    expect(text(page.html)).toContain('E2E Practice');

    const cookie = session.rawSetCookies.find((c) => c.includes('cliniqo_session'));
    expect(cookie, 'a session cookie was set').toBeTruthy();
    // Not readable by script, and not sent on cross-site navigations.
    expect(cookie!.toLowerCase()).toContain('httponly');
    expect(cookie!.toLowerCase()).toContain('samesite=lax');
  });

  it('lets an administrator read the audit log', async () => {
    const session = visitor();
    await signIn(session, '/login', cast.adminEmail);
    const page = await session.get('/audit');

    expect(page.status).toBe(200);
    expect(page.url).toContain('/audit');
  });

  it('refuses the audit log to a receptionist', async () => {
    const session = visitor();
    await signIn(session, '/login', cast.receptionEmail);
    const page = await session.get('/audit');

    /*
     * The point of doing this end-to-end rather than as a unit test: the receptionist is
     * refused by the real guard, on the real route, holding a real session — not by a
     * mocked permission set. Hiding the nav link is not access control, and this is what
     * proves the difference.
     */
    expect(page.url).not.toContain('/audit');
    expect(page.url).toMatch(/forbidden|dashboard|login/);
  });

  it('ends the session on sign-out', async () => {
    const session = visitor();
    const dashboard = await signIn(session, '/login', cast.adminEmail);

    const after = await session.submit(dashboard, 'Sign out');
    expect(after.url).toContain('/login');

    // And the session is genuinely gone, not merely redirected away from.
    const retry = await session.get('/dashboard');
    expect(retry.url).toContain('/login');
  });
});

/* ------------------------------------------------------------------------ portal */

describe('a patient using the portal', () => {
  it('signs in and reaches their own appointments', async () => {
    const session = visitor();
    const page = await signIn(session, '/portal/login', cast.patientEmail);

    expect(page.url).toMatch(/\/portal$/);
    expect(text(page.html)).toContain('Ada');
  });

  it('describes a symptom and is pointed at the right service', async () => {
    const session = visitor();
    await signIn(session, '/portal/login', cast.patientEmail);

    const assistant = await session.get('/portal/assistant');
    expect(assistant.status).toBe(200);

    const result = await session.submit(assistant, 'name="message"', {
      message: 'I have an itchy rash on my arm that has been there for a few days',
    });

    const body = text(result.html);
    expect(body).toContain('Dermatology');
    // The disclaimer must survive the round trip, not only the empty state.
    expect(body).toMatch(/not a diagnosis/i);

    const stored = await appPool.query(
      `SELECT recommended_specialty, urgency, engine
         FROM triage_conversation WHERE patient_id = $1`,
      [cast.patientId],
    );
    expect(stored.rows[0].recommended_specialty).toBe('Dermatology');
    expect(stored.rows[0].engine).toBe('local');
  });

  it('short-circuits an emergency and does NOT offer to book', async () => {
    /*
     * The most important assertion in this file. A patient describing a heart attack must
     * be told to call an ambulance, and must NOT be shown a booking prompt that competes
     * with it. Asserted through the whole stack because that is where it has to hold.
     */
    const session = visitor();
    await signIn(session, '/portal/login', cast.otherPatientEmail);

    const assistant = await session.get('/portal/assistant');
    const result = await session.submit(assistant, 'name="message"', {
      message: 'I have crushing chest pain and pain in my left arm',
    });

    const body = text(result.html);
    expect(body).toMatch(/this may be an emergency/i);
    expect(body).toMatch(/emergency number/i);
    expect(result.html).toContain('role="alert"');
    expect(body).not.toMatch(/suggested service/i);

    const stored = await appPool.query(
      `SELECT urgency, engine FROM triage_conversation c
         JOIN patient p ON p.id = c.patient_id
        WHERE p.email = $1`,
      [cast.otherPatientEmail],
    );
    expect(stored.rows[0].urgency).toBe('emergency');
    // No model was consulted: the red-flag path recorded itself as the author.
    expect(stored.rows[0].engine).toBe('red-flag');
  });

  it('shows one patient nothing of another patient', async () => {
    const ada = visitor();
    await signIn(ada, '/portal/login', cast.patientEmail);
    const adaPage = await ada.get('/portal/assistant');

    // Grace described chest pain in the previous journey; Ada described a rash.
    expect(text(adaPage.html)).not.toMatch(/chest pain/i);
    expect(text(adaPage.html)).toMatch(/rash/i);
  });

  it('audits the patient as the actor, with no symptom text in the log', async () => {
    const rows = await appPool.query(
      `SELECT actor_user_id, actor_patient_account_id, subject_patient_id, metadata
         FROM audit_event WHERE action IN ('triage.start','triage.message')`,
    );

    expect(rows.rowCount).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.actor_user_id).toBeNull();
      expect(row.actor_patient_account_id).not.toBeNull();
      expect(row.subject_patient_id).not.toBeNull();
      const meta = JSON.stringify(row.metadata).toLowerCase();
      expect(meta).not.toContain('rash');
      expect(meta).not.toContain('chest');
    }
  });

  it('never puts a patient identifier in a URL', async () => {
    const session = visitor();
    const home = await signIn(session, '/portal/login', cast.patientEmail);
    const assistant = await session.get('/portal/assistant');
    const sent = await session.submit(assistant, 'name="message"', {
      message: 'my knee aches after running',
    });

    for (const url of [...home.trail, ...assistant.trail, ...sent.trail]) {
      expect(url).not.toContain(cast.patientId);
      expect(url).not.toContain(cast.patientEmail);
    }
  });
});
