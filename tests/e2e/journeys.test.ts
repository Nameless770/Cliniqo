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

/* ----------------------------------------------------------------- google sso */

describe('Google sign-in', () => {
  /*
   * The e2e server IS configured with credentials that are never used, so the refusals
   * below are reached by the real checks rather than by the feature being switched off.
   * No request in this suite ever leaves for Google: every assertion lands before the
   * token exchange.
   */
  it('offers the button when configured, as a POST form', async () => {
    const page = await visitor().get('/login');

    expect(text(page.html)).toMatch(/sign in with google/i);
    /* A link would be followed by any prefetch. The form must POST. */
    expect(page.html).toMatch(/action="\/auth\/google\/start"[^>]*method="POST"/i);
    expect(text(page.html)).toMatch(/never creates one/i);
  });

  it('starts the flow only on POST, and sends a correct authorization request', async () => {
    const session = visitor();
    const page = await session.get('/login');
    const response = await session.submit(page, '/auth/google/start');

    const target = response.trail[response.trail.length - 1] ?? '';
    const url = new URL(target);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('openid email profile');

    /* And the handshake cookie came back httpOnly — it holds the PKCE verifier. */
    const handshake = session.rawSetCookies.find((c) => c.includes('cliniqo_oauth='));
    expect(handshake).toBeTruthy();
    expect(handshake!.toLowerCase()).toContain('httponly');
  });

  it('refuses the callback without a valid handshake', async () => {
    /*
     * The CSRF check, exercised against the real route. Arriving with a fabricated code
     * and state and no handshake cookie is exactly what an attacker who has stolen an
     * authorization code can do, and it must end at the sign-in page with no session.
     */
    const session = visitor();
    const response = await session.head('/auth/google/callback?code=forged&state=forged');

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location') ?? '').toContain('/login');

    // And crucially, nothing that looks like a session was handed out.
    const handed = session.rawSetCookies.filter((c) => c.includes('cliniqo_session='));
    expect(handed.every((c) => /cliniqo_session=;|cliniqo_session=""/.test(c))).toBe(
      true,
    );

    const still = await session.get('/dashboard');
    expect(still.url).toContain('/login');
  });

  it('does not start a flow on GET', async () => {
    /*
     * A GET would be triggerable by any <img> or prefetch on any page the user visits.
     * The start route is POST-only, so a stray navigation cannot begin authentication.
     */
    const response = await visitor().head('/auth/google/start');
    expect([404, 405]).toContain(response.status);
  });
});

/* ---------------------------------------------------------- portal google sso */

describe('Patient Google sign-in', () => {
  /*
   * Configured with credentials that are never used, same as the staff suite. Nothing
   * here leaves for Google: every assertion lands before the token exchange.
   */
  it('states what Google learns before offering the button', async () => {
    const page = await visitor().get('/portal/login');
    const body = text(page.html);

    expect(body).toMatch(/continue with google/i);

    /*
     * The notice is the control, not decoration. Pressing this button IS the disclosure
     * — the redirect tells Google that this person is signing in to a medical practice —
     * so the patient can only be the one choosing it if they were told first. A layout
     * change that moved the button above the notice, or dropped it, would leave a flow
     * that discloses something a patient never agreed to.
     */
    const notice = body.search(/tells Google that you have an account with this clinic/i);
    const button = body.search(/continue with google/i);
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(button);

    // And that the alternative shares nothing, so the choice is a real one.
    expect(body).toMatch(/password sign-in above shares nothing/i);
    expect(body).toMatch(/never creates one/i);

    /* A link would be followed by any prefetch. The form must POST. */
    expect(page.html).toMatch(
      /action="\/portal\/auth\/google\/start"[^>]*method="POST"/i,
    );
  });

  it('starts the flow at the portal redirect URI, under its own cookie', async () => {
    const session = visitor();
    const page = await session.get('/portal/login');
    const response = await session.submit(page, '/portal/auth/google/start');

    const url = new URL(response.trail[response.trail.length - 1] ?? '');
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');

    /* The PORTAL callback, not the staff one. Sharing a redirect URI would put both
       audiences behind one door. */
    expect(url.searchParams.get('redirect_uri')).toMatch(
      /\/portal\/auth\/google\/callback$/,
    );

    /*
     * Patients sign in with personal Google accounts, which carry no `hd` claim. A
     * hosted-domain hint here would ask Google to refuse every one of them.
     */
    expect(url.searchParams.has('hd')).toBe(false);

    const handshake = session.rawSetCookies.find((c) =>
      c.includes('cliniqo_portal_oauth='),
    );
    expect(handshake).toBeTruthy();
    expect(handshake!.toLowerCase()).toContain('httponly');

    // And emphatically NOT the staff handshake cookie.
    expect(session.rawSetCookies.some((c) => c.startsWith('cliniqo_oauth='))).toBe(false);
  });

  it('refuses the portal callback without a valid handshake', async () => {
    const session = visitor();
    const response = await session.head(
      '/portal/auth/google/callback?code=forged&state=forged',
    );

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get('location') ?? '').toContain('/portal/login');

    const handed = session.rawSetCookies.filter((c) => c.includes('cliniqo_portal='));
    expect(handed.every((c) => /cliniqo_portal=;|cliniqo_portal=""/.test(c))).toBe(true);

    const still = await session.get('/portal');
    expect(still.url).toContain('/portal/login');
  });

  it('cannot complete a portal handshake at the staff door, or the reverse', async () => {
    /*
     * ==================================================================
     * THE CROSS-DOOR TEST
     * ==================================================================
     *
     * The interesting attack on a two-audience SSO: begin a flow on the portal, then
     * finish it at the staff callback and see whether the patient's verified address also
     * matches a staff account. If it did, a patient's consent to sign in to their own
     * portal would have minted a staff session over the whole clinic's records.
     *
     * What forecloses it is that each callback reads only its own handshake cookie. So a
     * browser holding a live PORTAL handshake, arriving at the STAFF callback with the
     * matching state, must be refused — the staff door cannot see that handshake at all.
     */
    const session = visitor();
    const page = await session.get('/portal/login');
    const started = await session.submit(page, '/portal/auth/google/start');

    const state = new URL(started.trail[started.trail.length - 1] ?? '').searchParams.get(
      'state',
    );
    expect(state).toBeTruthy();

    // The real state from a real, live portal handshake — carried to the wrong door.
    const crossed = await session.head(
      `/auth/google/callback?code=whatever&state=${encodeURIComponent(state!)}`,
    );
    expect(crossed.headers.get('location') ?? '').toContain('/login?error=sso');

    const staffSession = session.rawSetCookies.filter((c) =>
      c.includes('cliniqo_session='),
    );
    expect(
      staffSession.every((c) => /cliniqo_session=;|cliniqo_session=""/.test(c)),
    ).toBe(true);

    // And the dashboard is still shut.
    const dash = await session.get('/dashboard');
    expect(dash.url).toContain('/login');
  });

  it('does not start a portal flow on GET', async () => {
    const response = await visitor().head('/portal/auth/google/start');
    expect([404, 405]).toContain(response.status);
  });
});

/* ---------------------------------------------------------------- motion layer */

describe('the motion layer', () => {
  /*
   * The second version of the design study is almost entirely movement, and movement is
   * the easiest thing to ship broken without noticing: the page still works, it just no
   * longer does the thing. These pin the markup each animation hangs off, against the real
   * production build, and the two places it carries a rule that is not decoration — who
   * sees the break-glass badge, and that a live status is only claimed when it is true.
   */
  let startedLocalDate: string;

  beforeAll(async () => {
    /*
     * One appointment under way right now, and one emergency grant awaiting review. Both
     * synthetic; both written straight to the database because what is under test is how
     * the pages DRAW them, not how they are created.
     */
    const startsAt = new Date(Date.now() - 5 * 60_000);
    const endsAt = new Date(Date.now() + 25 * 60_000);
    await appPool.query(
      `INSERT INTO appointment (clinic_id, patient_id, provider_user_id, appointment_type_id,
                                during, status)
       VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'), 'in_progress')`,
      [
        cast.clinicId,
        cast.patientId,
        cast.doctorId,
        cast.appointmentTypeId,
        startsAt.toISOString(),
        endsAt.toISOString(),
      ],
    );
    // The schedule's day view for the day it STARTED, in the clinic's zone.
    startedLocalDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(startsAt);

    await appPool.query(
      `INSERT INTO break_glass_grant (clinic_id, user_id, patient_id, reason, expires_at)
       VALUES ($1, $2, $3, 'E2E: synthetic emergency access for the review badge',
               now() + interval '1 hour')`,
      [cast.clinicId, cast.doctorId, cast.patientId],
    );
  });

  it('wraps staff and portal screens in the route transition', async () => {
    const staff = visitor();
    const dashboard = await signIn(staff, '/login', cast.adminEmail);
    expect(dashboard.html).toContain('class="cq-screen"');

    const patient = visitor();
    const portal = await signIn(patient, '/portal/login', cast.patientEmail);
    expect(portal.html).toContain('class="cq-screen"');
  });

  it('counts the dashboard up in CSS, with the true figure beside every counter', async () => {
    const session = visitor();
    const page = await signIn(session, '/login', cast.adminEmail);

    /*
     * Each animated counter must carry the same number as the screen-reader copy next to
     * it. If they drifted apart, a sighted user and a screen-reader user would be told
     * different things about the clinic — and nothing else would notice.
     */
    const pairs = [
      ...page.html.matchAll(
        /<span class="sr-only">(\d+)<\/span><span aria-hidden="true" class="cq-count" style="--cq-n:(\d+)"/g,
      ),
    ];
    expect(pairs.length, 'dashboard tiles render counters').toBeGreaterThanOrEqual(8);
    for (const [, spoken, animated] of pairs) expect(animated).toBe(spoken);
  });

  it('shows the break-glass badge to a reviewer, and to nobody else', async () => {
    const admin = visitor();
    const adminPage = await signIn(admin, '/login', cast.adminEmail);
    expect(text(adminPage.html)).toMatch(/Emergency access\s*1\s*, 1 awaiting review/);
    expect(adminPage.html).toContain('cq-pulse');

    /*
     * The reason the badge's permission check lives inside the data function rather than
     * in the layout: the layout runs for EVERY role. A receptionist must not learn from
     * the sidebar that emergency access to someone's record is waiting to be reviewed.
     */
    const reception = visitor();
    const receptionPage = await signIn(reception, '/login', cast.receptionEmail);
    expect(text(receptionPage.html)).not.toMatch(/awaiting review/);
    expect(receptionPage.html).not.toContain('cq-pulse');

    /*
     * The two assertions above are NOT enough, and were once all this test had. The Nav
     * also drops items a role may not use, so a receptionist never SEES the badge even if
     * the count is fetched — with the permission check deleted, this test still passed.
     * What the check actually prevents is the count being computed and handed to the Nav
     * Client Component, where it is serialised into the page source for anyone to read.
     * So assert on the payload, not the pixels: the admin's page carries the count, and
     * the receptionist's must not carry it at all.
     */
    /* The flight payload sits inside a JS string, so its quotes arrive as \" in the HTML. */
    const badgePayload = /\\?"\/break-glass\\?":\s*1/;
    expect(adminPage.html).toMatch(badgePayload);
    expect(receptionPage.html).not.toMatch(badgePayload);
  });

  it('rings the appointment that is in progress, and only that one', async () => {
    const session = visitor();
    await signIn(session, '/login', cast.adminEmail);
    const page = await session.get(`/schedule?date=${startedLocalDate}`);

    expect(page.status).toBe(200);
    /*
     * Counted as rendered ATTRIBUTES. The raw HTML also carries Next's serialised component
     * tree for hydration, which names the same class a second time as `"className"` — a
     * bare substring count sees every ring twice.
     */
    expect(page.html.match(/class="cq-live-ring"/g)?.length).toBe(1);
  });

  it('gives the portal a masthead that states whether the clinic is open', async () => {
    const session = visitor();
    const page = await signIn(session, '/portal/login', cast.patientEmail);
    const body = text(page.html);

    expect(body).toMatch(/Open now|Closed now/);
    expect(body).toMatch(/\d{2}:\d{2}(:\d{2})? clinic time/);
    // The seeded appointment is still under way, so it is the patient's next one.
    expect(body).toMatch(/Next: /);
  });
});
