import { redirect } from 'next/navigation';
import { activeProfile } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const profile = await activeProfile();
  if (!profile) redirect('/login');
  return (
    <main>
      <h1>papernook</h1>
      <p>Signed in as {profile.displayName}. The library arrives in phase 2.</p>
    </main>
  );
}
