'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/primitives';

/**
 * Sign-in form.
 *
 * Posts to /api/auth/login, which sets httpOnly cookies — the tokens are never
 * touched by JavaScript. Errors are surfaced inline rather than as a toast so
 * the message stays attached to the form.
 *
 * ## Why the submit button is NEVER disabled up-front
 *
 * This form previously rendered
 * `disabled={!identifier || !password}` on the submit button. Both fields start
 * empty, so the **server-rendered** HTML shipped the button already disabled —
 * and it could only ever become enabled once React hydrated on the client.
 *
 * That is fine on a fast localhost load and catastrophic on a real one: if the
 * JS chunk is slow, blocked, or fails to execute (a proxy stripping it, a stale
 * asset after a rebuild, an old browser), the operator can type a *correct*
 * username and password and the Sign in button simply never lights up. The page
 * looks fine and is unusable.
 *
 * The fix is the standard rule for hydrated forms: **a control's initial enabled
 * state must not depend on client state that begins empty.** So:
 *
 *   - `disabled` is derived ONLY from `loading` (a submit in flight), which is
 *     `false` on the server and stays false until the user actually submits.
 *   - Validation is done in `onSubmit` and by the native `required` attributes,
 *     both of which work with or without React.
 *   - A `<noscript>` notice tells the operator what to do when JS is off
 *     entirely, instead of leaving them with a form that silently does nothing.
 */
export function LoginForm({ defaultNext }: { defaultNext: string }) {
  const router = useRouter();
  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;

    // Validate here rather than via a state-derived `disabled`. This runs the
    // same whether or not the native `required` attribute was honoured, and it
    // gives a message instead of a dead button.
    const trimmedIdentifier = identifier.trim();
    if (!trimmedIdentifier || !password) {
      setError('Enter your username and password to continue.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await api.post('/api/auth/login', { identifier: trimmedIdentifier, password, remember }, { skipRefresh: true });

      // Only allow same-origin relative redirects.
      const target = defaultNext.startsWith('/') && !defaultNext.startsWith('//') ? defaultNext : '/dashboard';
      router.push(target);
      router.refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : 'Unable to sign in. Please try again.';
      setError(message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Sign in</h2>
        <p className="text-sm text-muted-foreground">
          Enter your credentials to access the panel.
        </p>
      </div>

      {/*
        Without JavaScript the form cannot POST (it has no action/method), so say
        so plainly instead of letting the operator press a button that does
        nothing. This is also the honest answer to "the Sign in button does not
        light up": check that the browser is running the page's scripts.
      */}
      <noscript>
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            JavaScript is disabled, so this form cannot sign you in. Enable
            JavaScript (or allow this site) and reload the page.
          </span>
        </div>
      </noscript>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="identifier">Username or email</Label>
        <Input
          id="identifier"
          name="identifier"
          autoComplete="username"
          autoFocus
          required
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          placeholder="admin@example.com"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={remember} onCheckedChange={(value) => setRemember(Boolean(value))} />
        Keep me signed in on this device
      </label>

      {/*
        Do NOT add `disabled={!identifier || !password}` back. `loading` is the
        only input to `disabled`, and it is false during the server render, so the
        button is always clickable on first paint — with or without hydration.
      */}
      <Button type="submit" className="w-full" disabled={loading} aria-busy={loading}>
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {loading ? 'Signing in…' : 'Sign in'}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Access is limited to accounts created by an administrator.
      </p>
    </form>
  );
}
