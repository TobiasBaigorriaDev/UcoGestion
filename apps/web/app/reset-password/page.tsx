import { ResetPasswordForm } from '../../src/features/identity/account-recovery';

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <main><ResetPasswordForm token={token ?? null} /></main>;
}
