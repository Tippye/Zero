import { useTRPCClient } from '@/providers/query-provider';
import { showLlmSetup } from '@/lib/llm-notice';
import { toast } from 'sonner';
import { m } from '@/paraglide/messages';

export function useEnsureLlm() {
  const client = useTRPCClient();
  return async () => {
    try {
      const result = await client.llm.list.query();
      if (result.ready) return true;
      showLlmSetup();
    } catch { toast.error(m['llm.operationFailed']()); }
    return false;
  };
}
