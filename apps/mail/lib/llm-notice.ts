import { toast } from 'sonner';
import { m } from '@/paraglide/messages';

export function showLlmSetup() {
  toast.error(m['llm.notConfigured'](), { id: 'llm-setup-required', duration: 12000,
    action: { label: m['llm.configure'](), onClick: () => window.open('/settings/llm', '_blank', 'noopener') },
  });
}
