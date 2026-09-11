'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  createInvoiceInput,
  issueInvoiceInput,
  recordPaymentInput,
  voidInvoiceInput,
} from '@/lib/billing-schemas';
import { formFields } from '@/lib/patient-schemas';
import { AuthorizationError } from '@/server/auth/authorize';
import {
  createInvoice,
  issueInvoice,
  recordPayment,
  voidInvoice,
} from '@/server/data-access/billing';

/**
 * Billing actions.
 *
 * Authorization lives in the data-access layer and is re-checked on every call; nothing
 * here trusts that the page which rendered a button did any checking. A clinician reaching
 * these endpoints directly is refused by the same guard that refuses them the page.
 */

export type BillingFormState = {
  errors?: Record<string, string[]>;
  message?: string;
  ok?: boolean;
};

function fieldErrors(error: import('zod').ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function authz(error: unknown): BillingFormState | null {
  if (error instanceof AuthorizationError) {
    return {
      message:
        error.reason === 'UNAUTHENTICATED'
          ? 'Your session has ended. Sign in again.'
          : 'You do not have permission to do that.',
    };
  }
  return null;
}

const DENIALS: Record<string, string> = {
  not_found: 'That invoice is no longer available.',
  not_draft: 'That invoice has already been issued.',
  not_issued: 'That invoice is not issued, so it cannot take a payment or be voided.',
  no_lines: 'An invoice needs at least one line.',
};

/**
 * Create a draft from the repeated line fields the form submits.
 *
 * `getAll` rather than a JSON blob, so the form degrades without JavaScript and the fields
 * stay individually validatable — a line with a bad amount names that line.
 */
export async function createInvoiceAction(
  _prev: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const patientId = String(formData.get('patientId') ?? '');
  const descriptions = formData.getAll('description');
  const codes = formData.getAll('code');
  const quantities = formData.getAll('quantity');
  const amounts = formData.getAll('unitAmount');

  const lines = descriptions
    .map((description, i) => ({
      description: String(description),
      code: String(codes[i] ?? '') || undefined,
      quantity: String(quantities[i] ?? '1'),
      unitAmount: String(amounts[i] ?? ''),
    }))
    // Blank rows are the form's spare slots, not input.
    .filter((line) => line.description.trim() !== '' || line.unitAmount.trim() !== '');

  const memo = String(formData.get('memo') ?? '').trim();
  const parsed = createInvoiceInput.safeParse({
    patientId,
    lines,
    ...(memo ? { memo } : {}),
  });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  let invoiceId: string;
  try {
    const result = await createInvoice({
      patientId: parsed.data.patientId,
      ...(parsed.data.memo ? { memo: parsed.data.memo } : {}),
      /* The schema parses `unitAmount` (a typed decimal) into cents; the data layer's
         field is named for what it stores. Renaming here keeps the boundary honest —
         nothing downstream ever sees a value that might be dollars. */
      lines: parsed.data.lines.map((line) => ({
        ...(line.code ? { code: line.code } : {}),
        description: line.description,
        quantity: line.quantity,
        unitAmountCents: line.unitAmount,
      })),
    });
    if (!result.ok) return { message: DENIALS[result.reason] ?? 'That did not work.' };
    invoiceId = result.invoiceId;
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }

  revalidatePath('/billing');
  redirect(`/billing/${invoiceId}`);
}

export async function issueInvoiceAction(
  _prev: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const parsed = issueInvoiceInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  try {
    const result = await issueInvoice(
      parsed.data.invoiceId,
      parsed.data.patientId,
      parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T23:59:59Z`) : null,
    );
    if (!result.ok) return { message: DENIALS[result.reason] ?? 'That did not work.' };

    revalidatePath(`/billing/${parsed.data.invoiceId}`);
    revalidatePath('/billing');
    return { ok: true, message: 'Invoice issued.' };
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }
}

export async function recordPaymentAction(
  _prev: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const parsed = recordPaymentInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  try {
    const result = await recordPayment({
      invoiceId: parsed.data.invoiceId,
      patientId: parsed.data.patientId,
      amountCents: parsed.data.amount,
      method: parsed.data.method,
      reference: parsed.data.reference,
    });
    if (!result.ok) return { message: DENIALS[result.reason] ?? 'That did not work.' };

    revalidatePath(`/billing/${parsed.data.invoiceId}`);
    revalidatePath('/billing');
    return {
      ok: true,
      message: result.settled ? 'Payment recorded. Invoice settled.' : 'Payment recorded.',
    };
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }
}

export async function voidInvoiceAction(
  _prev: BillingFormState,
  formData: FormData,
): Promise<BillingFormState> {
  const parsed = voidInvoiceInput.safeParse(formFields(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  try {
    const result = await voidInvoice(
      parsed.data.invoiceId,
      parsed.data.patientId,
      parsed.data.reason,
    );
    if (!result.ok) return { message: DENIALS[result.reason] ?? 'That did not work.' };

    revalidatePath(`/billing/${parsed.data.invoiceId}`);
    revalidatePath('/billing');
    return { ok: true, message: 'Invoice voided.' };
  } catch (error) {
    const a = authz(error);
    if (a) return a;
    throw error;
  }
}
