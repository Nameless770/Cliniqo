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

  /**
   * Clickjacking defence that actually applies to modern browsers, alongside the legacy
   * X-Frame-Options above.
   */
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // TODO(phase-2): replace 'unsafe-inline' with a per-request nonce issued from
      // middleware. Next's inline bootstrap script needs one or the other, and shipping
      // a nonce-based policy is a prerequisite for calling this hardened.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      // No third-party origins. Any future connection here is a PHI egress path and
      // needs a BAA before it is added.
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join('; '),
  },

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
