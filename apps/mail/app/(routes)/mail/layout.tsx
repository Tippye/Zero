import { HotkeyProviderWrapper } from '@/components/providers/hotkey-provider-wrapper';
import { OnboardingWrapper } from '@/components/onboarding';
import { AppSidebar } from '@/components/ui/app-sidebar';
import { Outlet } from 'react-router';

export default function MailLayout() {
  return (
    <HotkeyProviderWrapper>
      <AppSidebar />
      <div className="bg-sidebar dark:bg-sidebar w-full">
        <Outlet />
      </div>
      {import.meta.env.VITE_PUBLIC_SELF_HOSTED_AUTH !== 'required' && <OnboardingWrapper />}
    </HotkeyProviderWrapper>
  );
}
