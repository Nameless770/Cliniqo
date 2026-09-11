import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * Applied globally rather than per-route: a header that has to be remembered on each new
 * page is a header that will be missing on the page that matters.
 */
const securityHeaders = [
  /**
   * `no-referrer` rather than the usual `strict-origin-when-cross-origin`.
   *
   * A URL like /patients/<uuid> leaks in the Referer header to any external resource the
   * page loads. The UUID is not PHI on its own, but the referrer also reveals that this
   * clinic has a patient record open — and CLAUDE.md rules out PHI in exhaust of any
   * kind. Nothing in this application needs referrers.
   */
  { key: 'Referrer-Policy', value: 'no-referrer' },

  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },

  /*
   * Content-Security-Policy is NOT set here.
   *
   * It is emitted per-request from src/middleware.ts, because the nonce that replaced
   * 'unsafe-inline' (security review F2) has to be generated per request. Setting a
   * second, static CSP here would not be additive — a browser enforces every CSP header
   * it receives, so the weaker static policy would have to be satisfied too, and it
   * still contained 'unsafe-inline'. One policy, one place.
   */

  /** Nothing in a clinic app needs these. */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },

  /**
   * HSTS. Two years, subdomains included, preload-eligible.
   * Only meaningful over HTTPS; harmless on a local HTTP dev server.
   */
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Build output directory, overridable for the end-to-end suite.
   *
   * Those tests build and serve the application for real, and writing into the same
   * `.next` a running `next dev` owns clobbers it mid-session — which happened, and cost
   * a debugging detour. One environment variable keeps the two builds apart; nothing sets
   * it in normal use, so the default is unchanged.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',

  /** Do not advertise the framework version to attackers scanning for known CVEs. */
  poweredByHeader: false,

  typescript: {
    // A type error is a build failure. Never ship around it.
    ignoreBuildErrors: false,
  },

  // Next 16 removed the built-in `eslint` config key along with `next lint`. Linting is
  // its own step now — `npm run lint`, and `npm run verify` in CI.

  /**
   * `pg` is a native-ish Node module and must not be bundled into the server build's
   * traced output incorrectly. Keeping it external also guarantees it can never be
   * pulled toward a client boundary.
   */
  serverExternalPackages: ['pg'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
