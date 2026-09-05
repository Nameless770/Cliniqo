import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  LoadingState,
  Select,
  SkeletonRows,
  Spinner,
  Table,
  TableContainer,
  Td,
  Textarea,
  Th,
  Tr,
} from '@/components/ui';

import { InteractiveDemos } from './Interactive';
import styles from './styleguide.module.css';

export const metadata = { title: 'Styleguide · Cliniqo' };

/**
 * Cliniqo styleguide.
 *
 * A Server Component; only the dialog and toast demos cross the client boundary. That is
 * the same split feature pages should use.
 *
 * Every value shown here is invented. No PHI appears on this page, and none should ever
 * be added to it — a styleguide is the kind of page that gets shared in a ticket.
 */
export default function StyleguidePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Cliniqo styleguide</h1>
        <p className={styles.lede}>
          The visual foundation: tokens, shell, and primitives. Deep pine over warm
          neutrals — clinical without being cold, and distinct from the default blue every
          other record system reaches for. Every text and boundary pair here meets WCAG AA
          in both light and dark themes, verified by{' '}
          <code>scripts/check-contrast.js</code> rather than by eye.
        </p>
      </header>

      {/* ------------------------------------------------------------ colour */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Colour</h2>
        <p className={styles.sectionNote}>
          Semantic tokens, not raw palette values. Components reference{' '}
          <code>--text-primary</code>, never <code>--sand-900</code>, so the dark theme
          swaps one layer and nothing else needs to know.
        </p>

        <div className={styles.grid}>
          {[
            ['Brand solid', '--brand-solid'],
            ['Brand soft', '--brand-soft'],
            ['Page', '--bg-page'],
            ['Surface', '--bg-surface'],
            ['Sunken', '--bg-sunken'],
            ['Text primary', '--text-primary'],
            ['Text secondary', '--text-secondary'],
            ['Text muted', '--text-muted'],
            ['Border default', '--border-default'],
            ['Success', '--success-600'],
            ['Warning', '--warn-600'],
            ['Danger', '--danger-600'],
          ].map(([name, token]) => (
            <div key={token} className={styles.swatch}>
              <div
                className={styles.swatchColor}
                style={{ background: `var(${token})` }}
              />
              <div className={styles.swatchMeta}>
                <span className={styles.swatchName}>{name}</span>
                <span className={styles.swatchValue}>{token}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------------- typography */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Typography</h2>
        <p className={styles.sectionNote}>
          System font stack — not for speed, but because loading a webfont from a CDN
          means every page rendering a chart also calls a vendor with no BAA. Body default
          is 14px: clinical tools are dense, and 16px wastes rows in a schedule. Note
          bodies step up to 16px with relaxed leading.
        </p>

        <div className={styles.panel}>
          {[
            ['--text-2xl', '1.75rem', 'Patient record'],
            ['--text-xl', '1.375rem', 'Today at Riverside'],
            ['--text-lg', '1.125rem', 'Visit notes'],
            ['--text-md', '1rem', 'Long-form clinical prose sits at this size.'],
            ['--text-base', '0.875rem', 'Interface default — labels, buttons, body.'],
            ['--text-sm', '0.8125rem', 'Table rows and dense data.'],
            ['--text-xs', '0.75rem', 'Hints, captions, metadata.'],
          ].map(([token, size, sample]) => (
            <div key={token} className={styles.typeRow}>
              <span className={styles.typeToken}>
                {token}
                <br />
                {size}
              </span>
              <span style={{ fontSize: `var(${token})` }}>{sample}</span>
            </div>
          ))}
        </div>

        <div className={styles.panel}>
          <p className="tabular" style={{ fontSize: 'var(--text-sm)' }}>
            Tabular numerals: <strong>MRN-000418</strong> · 11:30 · 14:05 · 1,250 mg
          </p>
          <p
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-muted)',
              marginTop: 'var(--space-2)',
            }}
          >
            Applied to identifiers, times, and doses so digits align down a column.
            Proportional figures make a scanned list of MRNs unreadable.
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------------- spacing */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Spacing</h2>
        <p className={styles.sectionNote}>
          A 4px base scale, named by step rather than pixel value so the whole rhythm can
          be retuned in one place.
        </p>

        <div className={styles.panel}>
          {['1', '2', '3', '4', '5', '6', '8', '10', '12', '16'].map((step) => (
            <div key={step} className={styles.spaceRow}>
              <span className={styles.typeToken}>--space-{step}</span>
              <span
                className={styles.spaceBar}
                style={{ width: `var(--space-${step})` }}
                aria-hidden="true"
              />
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- buttons */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Buttons</h2>
        <p className={styles.sectionNote}>
          Destructive actions are red <em>and</em> say what they do. A button labelled
          &ldquo;Confirm&rdquo; in red tells a colourblind user nothing; &ldquo;Archive
          record&rdquo; tells everyone.
        </p>

        <div className={styles.panel}>
          <div className={styles.row}>
            <Button variant="primary">Save note</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="ghost">View history</Button>
            <Button variant="danger">Archive record</Button>
          </div>
          <div className={styles.row} style={{ marginTop: 'var(--space-4)' }}>
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
          </div>
          <div className={styles.row} style={{ marginTop: 'var(--space-4)' }}>
            <Button variant="primary" loading>
              Signing note
            </Button>
            <Button disabled>Disabled</Button>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- forms */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Form fields</h2>
        <p className={styles.sectionNote}>
          <code>Field</code> owns the wiring — <code>htmlFor</code>,{' '}
          <code>aria-describedby</code>, <code>aria-invalid</code>, and the required
          marker. That is where form accessibility usually breaks, so it exists once.
          Errors render in a <code>role=&quot;alert&quot;</code> region and carry an icon,
          never colour alone.
        </p>

        <div className={styles.panel}>
          <div className={styles.stack}>
            <Field
              id="sg-mrn"
              label="Medical record number"
              hint="Six digits, issued at registration."
              required
            >
              <Input name="mrn" placeholder="MRN-000418" inputMode="numeric" />
            </Field>

            <Field
              id="sg-type"
              label="Appointment type"
              hint="Coded, so the front desk never types clinical detail."
            >
              <Select name="type" defaultValue="">
                <option value="" disabled>
                  Select a type
                </option>
                <option value="fu">Follow-up</option>
                <option value="new">New patient</option>
                <option value="review">Medication review</option>
              </Select>
            </Field>

            <Field
              id="sg-dob"
              label="Date of birth"
              error="Enter a date in the past."
              required
            >
              <Input name="dob" type="date" defaultValue="2031-01-01" />
            </Field>

            <Field
              id="sg-note"
              label="Booking note"
              hint="Logistics only — wheelchair access, interpreter needed."
            >
              <Textarea name="note" rows={3} />
            </Field>

            <Field id="sg-disabled" label="Assigned clinician">
              <Input name="clinician" defaultValue="Dr N. Rahman" disabled />
            </Field>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ badges */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Status badges</h2>
        <p className={styles.sectionNote}>
          Word first, colour second, dot third. Three channels, because
          &ldquo;life-threatening allergy&rdquo; must never depend on distinguishing red
          from amber.
        </p>

        <div className={styles.panel}>
          <div className={styles.row}>
            <Badge tone="neutral">Booked</Badge>
            <Badge tone="info">Checked in</Badge>
            <Badge tone="success">Completed</Badge>
            <Badge tone="warning">No show</Badge>
            <Badge tone="danger">Life-threatening</Badge>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- table */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Table</h2>
        <p className={styles.sectionNote}>
          Real table elements, a caption, <code>scope</code> on headers, and{' '}
          <code>aria-sort</code> on sortable columns. The scroll container is focusable
          and labelled — a horizontally scrolling table that is not focusable cannot be
          scrolled by keyboard, which is a WCAG 2.1.1 failure most data tables ship with.
        </p>

        <TableContainer label="Today's appointments">
          <Table caption="Today's appointments">
            <thead>
              <Tr>
                <Th sort="ascending">Time</Th>
                <Th>Patient</Th>
                <Th>MRN</Th>
                <Th sort="none">Type</Th>
                <Th>Status</Th>
                <Th align="numeric">Duration</Th>
              </Tr>
            </thead>
            <tbody>
              {[
                ['09:00', 'A. Okonkwo', 'MRN-000412', 'Follow-up', 'Completed', '20 min'],
                [
                  '09:30',
                  'M. Silva',
                  'MRN-000418',
                  'New patient',
                  'Checked in',
                  '40 min',
                ],
                [
                  '10:15',
                  'J. Bergström',
                  'MRN-000421',
                  'Medication review',
                  'Booked',
                  '20 min',
                ],
                ['10:45', 'R. Haddad', 'MRN-000430', 'Follow-up', 'No show', '20 min'],
              ].map((row) => (
                <Tr key={row[2]}>
                  <Td variant="numeric">{row[0]}</Td>
                  <Td>{row[1]}</Td>
                  <Td variant="identifier">{row[2]}</Td>
                  <Td>{row[3]}</Td>
                  <Td>
                    <Badge
                      tone={
                        row[4] === 'Completed'
                          ? 'success'
                          : row[4] === 'Checked in'
                            ? 'info'
                            : row[4] === 'No show'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {row[4]}
                    </Badge>
                  </Td>
                  <Td variant="numeric">{row[5]}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableContainer>
      </section>

      {/* ------------------------------------------------- dialog and toasts */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Dialog and notifications</h2>
        <p className={styles.sectionNote}>
          The dialog is the native <code>&lt;dialog&gt;</code> element, so focus trapping,
          Escape, background inertness, and focus restoration come from the platform
          rather than being re-implemented badly. Toasts use two live regions: successes
          announce politely, errors interrupt — and errors never auto-dismiss, because a
          failed save that vanishes after four seconds is a failed save nobody saw.
        </p>

        <div className={styles.panel}>
          <InteractiveDemos />
        </div>
      </section>

      {/* --------------------------------------------------- empty / loading */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Empty and loading states</h2>
        <p className={styles.sectionNote}>
          &ldquo;No allergies recorded&rdquo; and &ldquo;could not load allergies&rdquo;
          must never render identically — the first reads as safe to proceed. Skeletons
          are <code>aria-hidden</code>; the spinner&rsquo;s live region is what actually
          announces loading.
        </p>

        <div className={styles.panel}>
          <EmptyState
            title="No appointments scheduled"
            description="Nothing is booked for this clinician today. Bookings made now will appear here immediately."
            action={<Button variant="primary">Book appointment</Button>}
          />
        </div>

        <div className={styles.panel}>
          <LoadingState label="Loading schedule…" />
        </div>

        <div className={styles.panel}>
          <SkeletonRows rows={4} />
        </div>

        <div className={styles.panel}>
          <div className={styles.row}>
            <Spinner size="sm" />
            <Spinner size="md" />
            <Spinner size="lg" />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Each carries a screen-reader label.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
