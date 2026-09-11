/**
 * A browser, minus the browser.
 *
 * WHY NOT PLAYWRIGHT. Adding it would mean a new dependency (CLAUDE.md says ask first),
 * a few hundred megabytes of browser binaries in CI, and a class of flake this project
 * has already been bitten by — three separate attempts to verify a flow through a real
 * browser this week ended with forms that silently never submitted.
 *
 * WHAT THIS DRIVES INSTEAD. Next renders every server-action form with full progressive
 * enhancement: a `method="POST"`, an `encType`, and hidden `$ACTION_REF_*` / `$ACTION_KEY`
 * fields carrying the action reference. That is the path a browser with JavaScript
 * disabled takes, and it runs the entire real stack — middleware and its CSP nonce, the
 * session cookie, the server action, the audited data layer, PostgreSQL, and the
 * re-rendered HTML. The only thing not exercised is client-side React, which is the one
 * layer that holds no authorization and no PHI rules.
 *
 * A useful side effect: every journey in this suite is also a proof the application works
 * without JavaScript, which for a clinic is an accessibility property worth having.
 */

const unescapeHtml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag);
  return match ? unescapeHtml(match[1]!) : null;
}

export type ParsedForm = {
  /** Resolved absolute URL the form posts to. */
  action: string;
  method: string;
  /** Every control's current value, in submission order. */
  fields: [string, string][];
  html: string;
};

/**
 * Every form on the page, with its controls read out.
 *
 * Deliberately a parser over our OWN markup rather than a general-purpose one: the shapes
 * here are the components in src/components/ui, and a dependency-free reader of them is
 * far less machinery than a DOM implementation for the same result.
 */
export function parseForms(html: string, pageUrl: string): ParsedForm[] {
  const forms: ParsedForm[] = [];

  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const openTag = `<form${match[1]}>`;
    const body = match[2]!;
    const fields: [string, string][] = [];

    for (const input of body.matchAll(/<input\b[^>]*>/gi)) {
      const tag = input[0];
      const name = attr(tag, 'name');
      if (!name) continue;
      const type = (attr(tag, 'type') ?? 'text').toLowerCase();
      // Unchecked boxes and radios are not submitted, exactly as a browser would do.
      if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/i.test(tag)) continue;
      fields.push([name, attr(tag, 'value') ?? '']);
    }

    for (const area of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = attr(`<textarea${area[1]}>`, 'name');
      if (name) fields.push([name, unescapeHtml(area[2] ?? '')]);
    }

    for (const select of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(`<select${select[1]}>`, 'name');
      if (!name) continue;
      const options = [...(select[2] ?? '').matchAll(/<option\b[^>]*>/gi)].map((o) => o[0]);
      const selected = options.find((o) => /\sselected\b/i.test(o)) ?? options[0];
      fields.push([name, selected ? (attr(selected, 'value') ?? '') : '']);
    }

    forms.push({
      action: new URL(attr(openTag, 'action') || pageUrl, pageUrl).toString(),
      method: (attr(openTag, 'method') ?? 'GET').toUpperCase(),
      fields,
      html: match[0]!,
    });
  }

  return forms;
}

export type PageResponse = {
  status: number;
  url: string;
  html: string;
  /** Every URL passed through, so a test can assert where a redirect landed. */
  trail: string[];
};

/**
 * One user's session: a cookie jar and the requests made with it.
 *
 * Two clients in a test are two different people, which is how the cross-patient scoping
 * checks stay honest — they use a second jar rather than trusting a parameter.
 */
export class BrowserSession {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  /** For assertions about cookie flags — HttpOnly, SameSite, the __Host- prefix. */
  readonly rawSetCookies: string[] = [];

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      this.rawSetCookies.push(raw);
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      // An expiry in the past is a deletion, which is how sign-out must be observable.
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(raw) || /max-age=0/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  private async follow(response: Response, trail: string[]): Promise<PageResponse> {
    let current = response;
    let hops = 0;

    while (current.status >= 300 && current.status < 400 && hops < 10) {
      const location = current.headers.get('location');
      if (!location) break;
      const next = new URL(location, current.url || this.baseUrl).toString();
      trail.push(next);

      /*
       * Stop at the edge of the application.
       *
       * Two reasons, and the second is the serious one. A test that followed a redirect
       * to accounts.google.com would make a real network call to Google — slow, flaky,
       * and reaching outside the suite. And this jar sends its cookies by name with no
       * domain check, so following off-origin would post the session cookie to somebody
       * else's server. The destination is recorded in the trail, which is what the
       * assertion actually needs.
       */
      if (new URL(next).origin !== new URL(this.baseUrl).origin) break;
      current = await fetch(next, {
        headers: { cookie: this.cookieHeader(), accept: 'text/html' },
        redirect: 'manual',
      });
      this.absorb(current);
      hops++;
    }

    return {
      status: current.status,
      url: trail[trail.length - 1] ?? this.baseUrl,
      html: await current.text(),
      trail,
    };
  }

  async get(path: string): Promise<PageResponse> {
    const url = new URL(path, this.baseUrl).toString();
    const response = await fetch(url, {
      headers: { cookie: this.cookieHeader(), accept: 'text/html' },
      redirect: 'manual',
    });
    this.absorb(response);
    return this.follow(response, [url]);
  }

  /** The raw response, unfollowed — for asserting on status codes and headers. */
  async head(path: string): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl).toString(), {
      headers: { cookie: this.cookieHeader(), accept: 'text/html' },
      redirect: 'manual',
    });
    this.absorb(response);
    return response;
  }

  /**
   * Submit a form from a page, the way a browser without JavaScript would.
   *
   * `find` picks the form by a substring of its own markup — usually a field name — so a
   * page with several forms does not need brittle indices.
   */
  async submit(
    page: PageResponse,
    find: string,
    values: Record<string, string> = {},
  ): Promise<PageResponse> {
    const forms = parseForms(page.html, page.url);
    const form = forms.find((f) => f.html.includes(find));
    if (!form) {
      throw new Error(
        `no form matching ${JSON.stringify(find)} on ${page.url} (${forms.length} form(s) present)`,
      );
    }

    const body = new FormData();
    const overridden = new Set(Object.keys(values));
    for (const [name, value] of form.fields) {
      if (overridden.has(name)) continue;
      body.append(name, value);
    }
    for (const [name, value] of Object.entries(values)) body.append(name, value);

    const response = await fetch(form.action, {
      method: form.method === 'GET' ? 'GET' : 'POST',
      headers: { cookie: this.cookieHeader(), accept: 'text/html' },
      body,
      redirect: 'manual',
    });
    this.absorb(response);
    return this.follow(response, [form.action]);
  }
}

/** Strip tags so an assertion reads the page's words rather than its markup. */
export function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
