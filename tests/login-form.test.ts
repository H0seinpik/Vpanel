import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The sign-in form must be usable on its very first paint, with or without
 * client-side hydration.
 *
 * ## The outage this guards against
 *
 * `login-form.tsx` is a `'use client'` component. It used to render
 *
 *   <Button type="submit" disabled={!identifier || !password}>
 *
 * Both `identifier` and `password` start as `''`. On the **server** render they
 * are still `''`, so the HTML shipped to the browser already contained
 *
 *   <button … disabled="" type="submit">Sign in</button>
 *
 * — confirmed by curling the page. The button could only ever become enabled
 * after React hydrated and the user typed. That is invisible on a fast localhost
 * load and fatal on a real one: the operator connected from another machine,
 * typed a **correct** username and password, and the Sign in button never lit
 * up. The page rendered perfectly and was completely unusable.
 *
 * The rule, generalised: **a form control's initial enabled state must never be
 * derived from client state that begins empty.** It makes the control's
 * availability a function of hydration, which is not something the operator can
 * see or fix.
 *
 * ## Why this is asserted against the source text
 *
 * The test environment is `node` — there is no jsdom or React renderer in this
 * project, so the component cannot be mounted here. Rendering it would also only
 * prove the client path; the bug was in the *server* HTML. Asserting on the
 * source is the honest check available: it pins the one expression that caused a
 * real, reported outage, and fails loudly if it is reintroduced.
 */

const FORM_SOURCE = readFileSync(
  join(process.cwd(), 'src/app/login/login-form.tsx'),
  'utf8',
);

/** The opening tag of the submit button, whitespace-collapsed. */
function submitButtonTag(): string {
  const match = FORM_SOURCE.match(/<Button\b[^>]*type=["']submit["'][^>]*>/);
  if (!match) throw new Error('no submit button found in login-form.tsx');
  return match[0].replace(/\s+/g, ' ');
}

describe('login form — hydrate-independence', () => {
  it('finds the submit button at all (guards a silent rename)', () => {
    expect(submitButtonTag()).toContain('type="submit"');
  });

  it('does NOT disable the submit button from the field values', () => {
    const tag = submitButtonTag();
    // The exact regression: any `disabled` expression mentioning the fields.
    expect(tag).not.toMatch(/disabled=\{[^}]*identifier/);
    expect(tag).not.toMatch(/disabled=\{[^}]*password/);
  });

  it('derives `disabled` only from the in-flight `loading` flag', () => {
    const tag = submitButtonTag();
    const disabled = tag.match(/disabled=\{([^}]*)\}/);
    expect(disabled, 'submit button should still disable while submitting').not.toBeNull();
    // `loading` is false during the server render, so first paint is clickable.
    expect(disabled![1].trim()).toBe('loading');
  });

  it('still validates empty fields, so removing the disable is not a hole', () => {
    // Validation moved into onSubmit; without it, an empty form would POST.
    expect(FORM_SOURCE).toMatch(/if \(!trimmedIdentifier \|\| !password\)/);
    expect(FORM_SOURCE).toMatch(/setError\(/);
  });

  it('keeps the native `required` attributes as the no-React safety net', () => {
    const requiredCount = (FORM_SOURCE.match(/\brequired\b/g) ?? []).length;
    expect(requiredCount).toBeGreaterThanOrEqual(2);
  });

  it('tells the operator what to do when JavaScript is off entirely', () => {
    // A dead form with no explanation is the failure mode being eliminated.
    expect(FORM_SOURCE).toContain('<noscript>');
    expect(FORM_SOURCE).toMatch(/JavaScript is disabled/i);
  });
});
