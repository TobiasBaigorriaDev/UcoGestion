import { AcceptInvitationForm } from '../../src/features/identity/account-recovery';

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <main><AcceptInvitationForm token={token ?? null} /></main>;
}
