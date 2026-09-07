import { PortalClaimForm } from './PortalClaimForm';

export const metadata = { title: 'Set your password · Cliniqo' };
export const dynamic = 'force-dynamic';

export default async function PortalClaimPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', marginTop: 'var(--space-8)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)', marginBottom: 'var(--space-1)' }}>
          Set your password
        </h1>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          Choose a password only you know. Nobody at the clinic can see it.
        </p>
      </div>
      <PortalClaimForm token={token} />
    </div>
  );
}
