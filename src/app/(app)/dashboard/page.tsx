import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { isStaff } from '@/lib/auth/rbac';
import { AdminDashboard } from '@/components/dashboard/admin-dashboard';
import { UserDashboard } from '@/components/dashboard/user-dashboard';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * Dashboard router.
 *
 * Staff get the fleet-wide admin dashboard; end users get their personal one.
 * The branch is decided on the server from the session, so a user can never
 * reach the admin view by manipulating the client.
 */
export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return isStaff(user.role) ? <AdminDashboard /> : <UserDashboard />;
}
