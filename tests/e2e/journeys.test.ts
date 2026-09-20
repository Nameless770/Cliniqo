import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signToken } from '@/lib/signed-token';

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
    expect(stored.rows[0].engine).toBe('local:2');
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

  it('holds a conversation in a new thread, typo and all, and ends with a suggestion', async () => {
    const session = visitor();
    await signIn(session, '/portal/login', cast.patientEmail);

    /* An empty id is what "Start a new conversation" sends: the next message opens one. */
    let page = await session.get('/portal/assistant');
    page = await session.submit(page, 'name="message"', {
      conversationId: '',
      message: 'i have stomech pain',
    });
    expect(text(page.html)).toMatch(/how long has this been going on/i);
    // A new thread: the earlier conversation about a rash is not on the page.
    expect(text(page.html)).not.toMatch(/itchy rash/i);

    for (const answer of ['3 days', '7', 'no']) {
      page = await session.submit(page, 'name="message"', { message: answer });
    }

    const body = text(page.html);
    expect(body).toMatch(/my suggestion:/i);
    expect(body).toMatch(/for 3 days, rated 7 out of 10/i);
    expect(body).toContain('Suggested service: Gastroenterology');

    const stored = await appPool.query(
      `SELECT c.recommended_specialty, c.urgency, c.engine,
              (SELECT count(*)::int FROM triage_message m WHERE m.conversation_id = c.id) AS turns
         FROM triage_conversation c
        WHERE c.patient_id = $1
        ORDER BY c.created_at DESC LIMIT 1`,
      [cast.patientId],
    );
    expect(stored.rows[0]).toMatchObject({
      recommended_specialty: 'Gastroenterology',
      urgency: 'urgent',
      engine: 'local:2',
      turns: 8,
    });
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
    /* Sign-up is on for this suite, so the page must say what a new account gets: nothing. */
    expect(text(page.html)).toMatch(/no access until an administrator gives you a role/i);
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
    expect(body).toMatch(
      /a new patient record that the clinic confirms at your first visit/i,
    );

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

  it('wraps the sign-in screens too, and marks up lists and chat turns for it', async () => {
    /*
     * These classes are decoration — every screen must be complete without them, which is
     * why nothing here asserts behaviour. What it does assert is that the markup a rule in
     * globals.css needs is actually emitted, since a renamed class fails silently: the page
     * still works, it just stops moving, and no other test would notice.
     */
    const anonymous = visitor();
    expect((await anonymous.get('/login')).html).toContain('class="cq-screen"');

    const staff = visitor();
    await signIn(staff, '/login', cast.adminEmail);
    expect((await staff.get('/staff')).html).toContain('cq-stagger');
    expect((await staff.get('/patients')).html).toContain('cq-stagger');

    const patient = visitor();
    await signIn(patient, '/portal/login', cast.patientEmail);
    const assistant = await patient.get('/portal/assistant');
    expect(assistant.html).toContain('cq-thread');
    // Each side arrives from its own side of the thread.
    expect(assistant.html).toContain('cq-said-you');
    expect(assistant.html).toContain('cq-said-bot');
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

/* ------------------------------------------------------------- self-registration */

describe('self-registration', () => {
  /*
   * The round trip through Google cannot run in a test. Everything after it can: the token
   * below is minted with the server's own secret, exactly as the callback would, and from
   * there the real pages, the real server actions and the real database do the rest.
   */
  const mint = (
    aud: 'staff' | 'portal',
    email: string,
    extra: Record<string, unknown> = {},
    secret = process.env['SESSION_SECRET'] ?? '',
  ) =>
    signToken(
      {
        aud,
        sub: `e2e-sub-${randomUUID()}`,
        email,
        name: 'E2E Newcomer',
        givenName: 'E2E',
        familyName: 'Newcomer',
        exp: Date.now() + 10 * 60_000,
        ...extra,
      },
      secret,
      'pending-signup',
    );

  it('never shows the Google confirmation step to someone who did not come from Google', async () => {
    /*
     * Without a token the sign-up pages show "Create an account" — never the step that
     * names a Google identity and offers to create an account for it.
     */
    const staff = await visitor().get('/signup');
    expect(text(staff.html)).toMatch(/create a staff account/i);
    expect(text(staff.html)).not.toMatch(/no staff account uses/i);

    const portal = await visitor().get('/portal/signup');
    expect(text(portal.html)).toMatch(/create your account/i);
    expect(text(portal.html)).not.toMatch(/signing in as/i);
  });

  it('refuses a token signed with anything but the server secret', async () => {
    const session = visitor();
    session.plantCookie(
      'cliniqo_portal_signup',
      mint(
        'portal',
        `forged-${randomUUID()}@e2e.local`,
        {},
        'an-attacker-secret-of-reasonable-length',
      ),
    );
    const page = await session.get('/portal/signup');
    /* The forged identity is never offered an account: only the ordinary form is shown. */
    expect(page.html).not.toContain('forged-');
    expect(text(page.html)).not.toMatch(/signing in as/i);
  });

  it('refuses a staff token on the patient sign-up page', async () => {
    /* A token proving a Google identity for one audience is never accepted by the other. */
    const session = visitor();
    session.plantCookie(
      'cliniqo_portal_signup',
      mint('staff', `crossed-${randomUUID()}@e2e.local`),
    );
    const page = await session.get('/portal/signup');
    expect(page.html).not.toContain('crossed-');
    expect(text(page.html)).not.toMatch(/signing in as/i);
  });

  it('lets a new staff member request access, and gives them nothing', async () => {
    const email = `requester-${randomUUID()}@e2e.local`;
    const session = visitor();
    session.plantCookie(
      'cliniqo_signup',
      mint('staff', email, { name: 'E2E Requester' }),
    );

    const page = await session.get('/signup');
    expect(page.status).toBe(200);
    expect(text(page.html)).toMatch(/starts with no access/i);
    expect(text(page.html)).toContain(email);

    const landed = await session.submit(page, 'name="fullName"', {
      fullName: 'E2E Requester',
    });
    expect(landed.url).toContain('/dashboard');
    expect(text(landed.html)).toMatch(/waiting for an administrator/i);

    /*
     * Signed in, and still refused everywhere that matters — by each page's own guard, not by
     * the waiting screen. This is the property that makes staff self-registration safe.
     */
    for (const path of ['/patients', '/schedule', '/audit']) {
      const refused = await session.get(path);
      expect(refused.url, `${path} must refuse an account with no role`).not.toContain(
        path,
      );
    }

    const account = await appPool.query<{ roles: number; self_registered: boolean }>(
      `SELECT (SELECT count(*)::int FROM user_role r
                WHERE r.user_id = ua.id AND r.revoked_at IS NULL) AS roles,
              ua.self_registered_at IS NOT NULL AS self_registered
         FROM user_account ua WHERE ua.email = $1`,
      [email],
    );
    expect(account.rows[0]!.roles).toBe(0);
    expect(account.rows[0]!.self_registered).toBe(true);

    /* And the administrator is told someone is waiting. */
    const admin = visitor();
    await signIn(admin, '/login', cast.adminEmail);
    const staff = await admin.get('/staff');
    expect(text(staff.html)).toMatch(/requested access/i);
    expect(text(staff.html)).toMatch(/waiting for a role/i);
  });

  it('lets a new patient register, as a new record even with the same name and birthday', async () => {
    /*
     * The seeded patient is Ada Tester, born 1990-01-01, with an account of her own. A
     * newcomer typing exactly that must get their own record and never hers.
     */
    const email = `newpatient-${randomUUID()}@e2e.local`;
    const session = visitor();
    const token = mint('portal', email, { givenName: 'Ada', familyName: 'Tester' });
    session.plantCookie('cliniqo_portal_signup', token);

    const page = await session.get('/portal/signup');
    expect(page.status).toBe(200);
    expect(text(page.html)).toMatch(/does not connect you to your existing records/i);

    const landed = await session.submit(page, 'name="legalFirstName"', {
      legalFirstName: 'Ada',
      legalLastName: 'Tester',
      dateOfBirth: '1990-01-01',
      phonePrimary: '',
    });
    expect(landed.url).toContain('/portal');
    expect(text(landed.html)).toMatch(/your account is ready/i);

    const record = await appPool.query<{ patient_id: string }>(
      `SELECT patient_id FROM patient_account WHERE email = $1`,
      [email],
    );
    expect(record.rowCount).toBe(1);
    expect(record.rows[0]!.patient_id).not.toBe(cast.patientId);

    /*
     * What "single use" really means for a stateless token. The browser's copy is cleared
     * the moment it is spent. A copy taken beforehand is still validly signed until it
     * expires — so what must hold is that replaying it cannot create a second account.
     */
    expect(
      session.rawSetCookies.some(
        (c) => /^cliniqo_portal_signup=;/.test(c) && /max-age=0/i.test(c),
      ),
      'the pending sign-up cookie is cleared once spent',
    ).toBe(true);

    const replay = visitor();
    replay.plantCookie('cliniqo_portal_signup', token);
    const again = await replay.get('/portal/signup');
    const refused = await replay.submit(again, 'name="legalFirstName"', {
      legalFirstName: 'Ada',
      legalLastName: 'Tester',
      dateOfBirth: '1990-01-01',
      phonePrimary: '',
    });
    expect(refused.url).toContain('/portal/login');
    const accounts = await appPool.query(
      `SELECT 1 FROM patient_account WHERE email = $1`,
      [email],
    );
    expect(accounts.rowCount).toBe(1);

    /* Staff see the record flagged, and can clear the flag after checking ID. */
    const desk = visitor();
    await signIn(desk, '/login', cast.receptionEmail);
    const chart = await desk.get(`/patients/${record.rows[0]!.patient_id}`);
    expect(text(chart.html)).toMatch(/registered online, identity not yet checked/i);

    const confirmed = await desk.submit(chart, 'I have checked their photo ID');
    expect(text(confirmed.html)).toMatch(/registered online · identity checked/i);
    expect(text(confirmed.html)).not.toMatch(/identity not yet checked/i);

    const verified = await appPool.query<{ verified: boolean }>(
      `SELECT identity_verified_at IS NOT NULL AS verified FROM patient WHERE id = $1`,
      [record.rows[0]!.patient_id],
    );
    expect(verified.rows[0]!.verified).toBe(true);
  });
});

/* --------------------------------------------------------- request correlation */

/*
 * Security review finding F12.
 *
 * `audit_event.request_id` existed in the schema from phase 2 and was written as NULL by
 * every one of the twenty-six call sites, so the rows one request produced could only be
 * related by actor and timestamp. The failure mode is specifically a silent one — the
 * column reads as a feature and every row looks well-formed — which is why the check is
 * here, against a real server, rather than only in the static invariants.
 */
describe('request correlation', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('gives every response its own correlation id', async () => {
    const first = await visitor().head('/login');
    const second = await visitor().head('/login');

    const a = first.headers.get('x-request-id') ?? '';
    const b = second.headers.get('x-request-id') ?? '';

    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    // A reused id would group unrelated work under one reference, which is worse than none.
    expect(a).not.toBe(b);
  });

  it('records the id on the audit rows a real request writes', async () => {
    const session = visitor();
    const page = await signIn(session, '/login', cast.adminEmail);
    expect(page.url).toContain('/dashboard');

    /*
     * Pinned to this actor, and deliberately NOT filtered on `request_id IS NOT NULL`.
     * Filtering on it would make the query skip past an uncorrelated row to an older
     * correlated one and report success — the vacuous pass this suite exists to avoid.
     */
    const actor = await appPool.query<{ id: string }>(
      `SELECT id FROM user_account WHERE email = $1`,
      [cast.adminEmail],
    );
    const logged = await appPool.query<{ request_id: string | null }>(
      `SELECT request_id FROM audit_event
        WHERE action = 'auth.login' AND outcome = 'allowed' AND actor_user_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [actor.rows[0]!.id],
    );

    expect(logged.rowCount, 'the sign-in wrote an audit row').toBe(1);
    expect(logged.rows[0]!.request_id, 'that row carries a correlation id').toMatch(UUID);
  });

  it('never lets one correlation id span two sessions', async () => {
    /*
     * The property that makes the id evidence rather than decoration. An id shared across
     * sessions is what an inbound, client-supplied `x-request-id` would produce — one
     * account stitching its reads onto another's reference. Middleware overwrites the
     * inbound header precisely so this cannot happen; this asserts the result.
     */
    const grouped = await appPool.query<{ request_id: string; sessions: number }>(
      `SELECT request_id, count(DISTINCT session_id)::int AS sessions
         FROM audit_event
        WHERE request_id IS NOT NULL AND session_id IS NOT NULL
        GROUP BY request_id`,
    );

    expect(grouped.rowCount, 'the journeys above wrote correlated rows').toBeGreaterThan(
      0,
    );
    for (const row of grouped.rows) {
      expect(row.sessions, `request ${row.request_id} spans one session`).toBe(1);
    }
  });
});

/* ------------------------------------------------------------------ patient merge */

/*
 * Merge is administrator-only. The integration suite covers what a merge DOES; these two
 * cover who can reach it, over real HTTP, through the layout and the page guard — the
 * layer where a missing `guardPage` looks fine in review and is wide open in production.
 */
describe('merging a duplicate chart', () => {
  it('lets an administrator open the merge screen', async () => {
    const session = visitor();
    await signIn(session, '/login', cast.adminEmail);

    const page = await session.get(`/patients/${cast.patientId}/merge`);

    expect(page.status).toBe(200);
    expect(page.url).toContain('/merge');
    expect(text(page.html)).toMatch(/merge a duplicate into this chart/i);
  });

  it('refuses the front desk, who can spot a duplicate but not commit one', async () => {
    const desk = visitor();
    await signIn(desk, '/login', cast.receptionEmail);

    const page = await desk.get(`/patients/${cast.patientId}/merge`);

    expect(page.url).toContain('/forbidden');
    expect(text(page.html)).not.toMatch(/merge a duplicate into this chart/i);

    /* The refusal is recorded, like every other boundary refusal. */
    const denied = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event
        WHERE action = 'authz.denied' AND metadata->>'permission' = 'patient.merge'`,
    );
    expect(Number(denied.rows[0]!.n)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- two-step sign-in */

/*
 * The second factor, driven the way a person meets it.
 *
 * The integration suite proves the codes themselves. What only this layer can prove is the
 * part that actually protects anything: that the password step creates NO session, so a
 * correct password and a missing phone leaves the visitor with nothing.
 */
describe('two-step sign-in', () => {
  const PASSWORD_ONLY = '/dashboard';

  /** A staff account of its own, enrolled, so no other journey is affected. */
  async function enrolledStaff() {
    const { hashPassword } = await import('@/server/auth/password');
    const { generateSecret, sealSecret } = await import('@/server/auth/totp');

    const tag = randomUUID().slice(0, 8);
    const email = `mfa-${tag}@e2e.local`;
    const secret = generateSecret();

    const user = await appPool.query<{ id: string }>(
      `INSERT INTO user_account (clinic_id, email, password_hash, full_name, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [cast.clinicId, email, await hashPassword(PASSWORD), `E2E MFA ${tag}`],
    );
    const userId = user.rows[0]!.id;

    await appPool.query(
      `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'receptionist'`,
      [userId],
    );
    await appPool.query(
      `INSERT INTO user_totp (user_id, secret_sealed, confirmed_at)
       VALUES ($1, $2, now())`,
      [userId, sealSecret(secret, process.env['SESSION_SECRET']!)],
    );

    return { email, secret, userId };
  }

  it('stops at the code step, and grants NO session on the password alone', async () => {
    const { email, userId } = await enrolledStaff();

    const session = visitor();
    const afterPassword = await signIn(session, '/login', email);

    /* The password was right, and it was not enough. */
    expect(afterPassword.url).toContain('/login/verify');
    expect(text(afterPassword.html)).toMatch(/one more step/i);

    /*
     * THE assertion. Holding whatever cookies the password step set, the dashboard is
     * still out of reach — because no session row was created, not because a page guard
     * happened to catch it.
     */
    const dashboard = await session.get(PASSWORD_ONLY);
    expect(dashboard.url).not.toContain('/dashboard');

    const live = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(Number(live.rows[0]!.n)).toBe(0);
  });

  it('completes the sign-in when the code is right', async () => {
    const { email, secret, userId } = await enrolledStaff();
    const { codeFor, stepFor } = await import('@/server/auth/totp');

    const session = visitor();
    const challenge = await signIn(session, '/login', email);
    expect(challenge.url).toContain('/login/verify');

    const done = await session.submit(challenge, 'name="code"', {
      code: codeFor(secret, stepFor(Date.now())),
    });

    expect(done.url).toContain('/dashboard');

    /* And only now does a session exist — with the login audited as having used a factor. */
    const live = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(Number(live.rows[0]!.n)).toBe(1);

    const audit = await appPool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_event
        WHERE actor_user_id = $1 AND action = 'auth.login' AND outcome = 'allowed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [userId],
    );
    expect(audit.rows[0]!.metadata['secondFactor']).toBe('totp');
  });

  it('refuses a wrong code and still grants nothing', async () => {
    const { email, userId } = await enrolledStaff();

    const session = visitor();
    const challenge = await signIn(session, '/login', email);
    const refused = await session.submit(challenge, 'name="code"', { code: '000000' });

    expect(refused.url).not.toContain('/dashboard');
    const live = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM session WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    expect(Number(live.rows[0]!.n)).toBe(0);
  });

  it('sends someone with no challenge straight back to sign-in', async () => {
    /* The verify page grants nothing on its own: without the signed cookie there is no
       account to speak of, so there is nothing to reach by typing the URL. */
    const page = await visitor().get('/login/verify');
    expect(page.url).toContain('/login');
    expect(page.url).not.toContain('/verify');
  });
});

/* ------------------------------------------------------------------ visit notes */

describe('visit notes in the portal', () => {
  /*
   * Three notes for the seeded patient, written straight to the database — what is under
   * test is what each audience is SHOWN. Each carries a phrase that must never appear where
   * it should not, searched for in the raw HTML, which includes Next's serialised payload.
   */
  const notes = { visible: '', draft: '', held: '' };

  async function note(
    status: 'draft' | 'signed',
    phrase: string,
    withheld: boolean,
  ): Promise<string> {
    const row = await appPool.query<{ id: string }>(
      `INSERT INTO visit_note (clinic_id, patient_id, author_user_id, status, signed_at, signed_by,
                               portal_withheld_at, portal_withheld_by, portal_withheld_reason)
       VALUES ($1, $2, $3::uuid, $4::visit_note_status,
               CASE WHEN $4::text = 'draft' THEN NULL ELSE now() END,
               CASE WHEN $4::text = 'draft' THEN NULL ELSE $3::uuid END,
               CASE WHEN $5::boolean THEN now() END,
               CASE WHEN $5::boolean THEN $3::uuid END,
               CASE WHEN $5::boolean THEN 'E2E-REASON-TEXT: talk in person first' END)
       RETURNING id`,
      [cast.clinicId, cast.patientId, cast.doctorId, status, withheld],
    );
    const id = row.rows[0]!.id;
    const version = await appPool.query<{ id: string }>(
      `INSERT INTO visit_note_version (clinic_id, visit_note_id, version_number, kind,
                                       chief_complaint, plan, authored_by_user_id, frozen_at)
       VALUES ($1, $2, 1, $3::visit_note_version_kind, $4, 'Rest and fluids', $5,
               CASE WHEN $3::text = 'draft' THEN NULL ELSE now() END)
       RETURNING id`,
      [cast.clinicId, id, status === 'draft' ? 'draft' : 'signed', phrase, cast.doctorId],
    );
    await appPool.query(`UPDATE visit_note SET current_version_id = $1 WHERE id = $2`, [
      version.rows[0]!.id,
      id,
    ]);
    return id;
  }

  beforeAll(async () => {
    notes.visible = await note('signed', 'E2E-VISIBLE-NOTE sore throat', false);
    notes.draft = await note('draft', 'E2E-DRAFT-NOTE unfinished', false);
    notes.held = await note('signed', 'E2E-HELD-NOTE difficult news', true);
  });

  it('shows a patient their signed notes, and never a draft or a held-back note', async () => {
    const session = visitor();
    await signIn(session, '/portal/login', cast.patientEmail);

    const home = await session.get('/portal');
    expect(home.html).toContain('href="/portal/visits"');

    const page = await session.get('/portal/visits');
    expect(page.status).toBe(200);
    const body = text(page.html);

    expect(body).toContain('E2E-VISIBLE-NOTE');
    expect(body).toMatch(/reason for visit/i);

    /* The raw HTML, not just the visible text: nothing may hide in the page payload either. */
    expect(page.html).not.toContain('E2E-DRAFT-NOTE');
    expect(page.html).not.toContain('E2E-HELD-NOTE');
    expect(page.html).not.toContain('E2E-REASON-TEXT');

    /* But the patient is told a note was held back, and that they can ask for a review. */
    expect(body).toMatch(/not available online yet/i);
    expect(body).toMatch(/reviewed by another clinician/i);
  });

  it('shows another patient none of it', async () => {
    const session = visitor();
    await signIn(session, '/portal/login', cast.otherPatientEmail);
    const page = await session.get('/portal/visits');

    expect(page.status).toBe(200);
    expect(page.html).not.toContain('E2E-VISIBLE-NOTE');
    expect(text(page.html)).not.toMatch(/not available online yet/i);
  });

  it('tells staff whether the patient can see a note, and gives the control only to clinicians', async () => {
    const admin = visitor();
    await signIn(admin, '/login', cast.adminEmail);

    const visible = await admin.get(`/notes/${notes.visible}?patient=${cast.patientId}`);
    expect(text(visible.html)).toMatch(/visible to the patient in their portal/i);

    const held = await admin.get(`/notes/${notes.held}?patient=${cast.patientId}`);
    expect(text(held.html)).toMatch(/hidden from the patient/i);
    expect(text(held.html)).toContain('E2E-REASON-TEXT');

    /*
     * An administrator can read notes but cannot sign them, so gets no hide or release
     * button. Withholding is a clinical judgement; the data layer refuses it regardless.
     */
    expect(held.html).not.toMatch(/release to patient portal/i);
    expect(visible.html).not.toMatch(/hide from patient portal/i);
  });
});

/* ------------------------------------------------------------ password sign-up */

describe('creating an account with an email and password', () => {
  /* Same neutral words on the sign-in page whether or not an account was created. */
  const NEUTRAL = /now sign in with the email and password you chose/i;

  it('offers "Create an account" on both sign-in pages', async () => {
    const staff = await visitor().get('/login');
    expect(staff.html).toContain('href="/signup"');
    expect(text(staff.html)).toMatch(/create an account/i);

    const portal = await visitor().get('/portal/login');
    expect(portal.html).toContain('href="/portal/signup"');
  });

  it('lets a new staff member create an account, sign in, and see nothing yet', async () => {
    const email = `pw-staff-${randomUUID()}@e2e.local`;
    const session = visitor();

    const form = await session.get('/signup');
    const landed = await session.submit(form, 'name="confirm"', {
      fullName: 'E2E Password Applicant',
      email,
      password: 'a long enough e2e passphrase',
      confirm: 'a long enough e2e passphrase',
    });
    expect(landed.url).toContain('/login');
    expect(text(landed.html)).toMatch(NEUTRAL);

    /* No session was handed out by the sign-up itself. */
    expect((await session.get('/dashboard')).url).toContain('/login');

    const signedIn = await session.submit(landed, 'name="email"', {
      email,
      password: 'a long enough e2e passphrase',
    });
    expect(signedIn.url).toContain('/dashboard');
    expect(text(signedIn.html)).toMatch(/waiting for an administrator/i);

    /* Still no access to anything, by each page's own guard. */
    expect((await session.get('/patients')).url).not.toContain('/patients');

    /* And the administrator is warned the address was never confirmed. */
    const admin = visitor();
    await signIn(admin, '/login', cast.adminEmail);
    const staffPage = await admin.get('/staff');
    expect(text(staffPage.html)).toMatch(/email not confirmed/i);
  });

  it('answers a taken staff address exactly the same, and changes nothing', async () => {
    /* The seeded administrator's address, with a password the "attacker" chooses. */
    const session = visitor();
    const form = await session.get('/signup');
    const landed = await session.submit(form, 'name="confirm"', {
      fullName: 'Not The Administrator',
      email: cast.adminEmail,
      password: 'an attacker chosen passphrase',
      confirm: 'an attacker chosen passphrase',
    });
    expect(landed.url).toContain('/login');
    expect(text(landed.html)).toMatch(NEUTRAL);
    expect(text(landed.html)).not.toMatch(/already registered|already exists|taken/i);

    /* The attacker's password does not open the account… */
    const attempt = await session.submit(landed, 'name="email"', {
      email: cast.adminEmail,
      password: 'an attacker chosen passphrase',
    });
    expect(attempt.url).not.toContain('/dashboard');

    /* …and the real password still does. */
    const owner = visitor();
    expect((await signIn(owner, '/login', cast.adminEmail)).url).toContain('/dashboard');
  });

  it('lets a new patient create an account, as a new record, and sign in', async () => {
    const email = `pw-patient-${randomUUID()}@e2e.local`;
    const session = visitor();

    const form = await session.get('/portal/signup');
    expect(text(form.html)).toMatch(/does not connect you to your existing records/i);

    const landed = await session.submit(form, 'name="confirm"', {
      legalFirstName: 'Ada',
      legalLastName: 'Tester',
      dateOfBirth: '1990-01-01',
      phonePrimary: '',
      email,
      password: 'a long enough e2e passphrase',
      confirm: 'a long enough e2e passphrase',
    });
    expect(landed.url).toContain('/portal/login');
    expect(text(landed.html)).toMatch(NEUTRAL);

    const signedIn = await session.submit(landed, 'name="email"', {
      email,
      password: 'a long enough e2e passphrase',
    });
    expect(signedIn.url).toMatch(/\/portal$/);

    /* Same name and birthday as the seeded Ada — and still a record of its own. */
    const record = await appPool.query<{ patient_id: string }>(
      `SELECT patient_id FROM patient_account WHERE email = $1`,
      [email],
    );
    expect(record.rows[0]!.patient_id).not.toBe(cast.patientId);
  });

  it('answers a taken patient address exactly the same, and changes nothing', async () => {
    const session = visitor();
    const form = await session.get('/portal/signup');
    const landed = await session.submit(form, 'name="confirm"', {
      legalFirstName: 'Someone',
      legalLastName: 'Else',
      dateOfBirth: '1991-02-03',
      phonePrimary: '',
      email: cast.patientEmail,
      password: 'an attacker chosen passphrase',
      confirm: 'an attacker chosen passphrase',
    });
    expect(landed.url).toContain('/portal/login');
    expect(text(landed.html)).toMatch(NEUTRAL);
    expect(text(landed.html)).not.toMatch(/already registered|already exists|taken/i);

    const attempt = await session.submit(landed, 'name="email"', {
      email: cast.patientEmail,
      password: 'an attacker chosen passphrase',
    });
    expect(attempt.url).not.toMatch(/\/portal$/);

    const owner = visitor();
    expect((await signIn(owner, '/portal/login', cast.patientEmail)).url).toMatch(
      /\/portal$/,
    );
  });

  it('answers a form mistake on the page, without creating anything', async () => {
    const email = `pw-short-${randomUUID()}@e2e.local`;
    const session = visitor();
    const form = await session.get('/signup');
    const result = await session.submit(form, 'name="confirm"', {
      fullName: 'Short Password',
      email,
      password: 'short',
      confirm: 'short',
    });
    expect(result.url).toContain('/signup');
    expect(text(result.html)).toMatch(/at least 12 characters/i);

    const rows = await appPool.query(`SELECT 1 FROM user_account WHERE email = $1`, [
      email,
    ]);
    expect(rows.rowCount).toBe(0);
  });
});
