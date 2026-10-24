import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';

/** The root path is just a router: authenticated → dashboard, otherwise → login. */
export default async function RootPage() {
  const user = await getCurrentUser();
  redirect(user ? '/dashboard' : '/login');
}
