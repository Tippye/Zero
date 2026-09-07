import { ClassificationControls } from '@/components/settings/classification-controls';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useTRPC, useTRPCClient } from '@/providers/query-provider';
import { SettingsCard } from '@/components/settings/settings-card';
import { Plus, Pencil, Trash, Loader2, Check } from 'lucide-react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import type { Outputs } from '@zero/server/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { m } from '@/paraglide/messages';
import { toast } from 'sonner';

type Profile = Outputs['llm']['list']['profiles'][number];
const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const errors = {
    LLM_NETWORK_FAILED: m['llm.networkFailed'],
    LLM_TIMEOUT: m['llm.timeout'],
    LLM_ACCESS_DENIED: m['llm.accessDenied'],
    LLM_RATE_LIMITED: m['llm.rateLimited'],
    LLM_QUOTA_EXCEEDED: m['llm.quotaExceeded'],
    LLM_MODEL_NOT_FOUND: m['llm.modelNotFound'],
    LLM_MODEL_REQUIRED: m['llm.modelRequired'],
    LLM_INVALID_RESPONSE: m['llm.invalidResponse'],
    LLM_EMPTY_RESPONSE: m['llm.emptyResponse'],
    LLM_REDIRECT_DISABLED: m['llm.redirectDisabled'],
    LLM_REQUEST_REJECTED: m['llm.requestRejected'],
    LLM_UPSTREAM_FAILED: m['llm.upstreamFailed'],
  };
  for (const [code, text] of Object.entries(errors)) if (message.includes(code)) return text();
  return message.includes('LLM_KEY_REQUIRED')
    ? m['llm.keyRequired']()
    : message.includes('LLM_INVALID_URL')
      ? m['llm.invalidUrl']()
      : message.includes('LLM_AUTH_FAILED')
        ? m['llm.authFailed']()
        : message.includes('LLM_MODELS_UNSUPPORTED')
          ? m['llm.modelsUnsupported']()
          : message.includes('LLM_MODELS_FAILED')
            ? m['llm.modelsFailed']()
            : m['llm.operationFailed']();
};

export default function LlmSettingsPage() {
  const trpc = useTRPC(),
    client = useTRPCClient(),
    cache = useQueryClient();
  const list = useQuery(
    trpc.llm.list.queryOptions(undefined, {
      retry: false,
      meta: { persist: false },
      trpc: { abortOnUnmount: true },
    }),
  );
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [removing, setRemoving] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );
  const refresh = async () => {
    setTestResults({});
    await cache.invalidateQueries({ queryKey: trpc.llm.list.queryKey() });
    await cache.invalidateQueries({ queryKey: trpc.imap.aiSettings.queryKey() });
  };
  async function action(task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await task();
      await refresh();
      setRemoving(null);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function testProfile(profile: Profile) {
    if (busy) return;
    setBusy(true);
    setTesting(profile.id);
    setTestResults((previous) => {
      const next = { ...previous };
      delete next[profile.id];
      return next;
    });
    try {
      const result = await client.llm.test.mutate({ id: profile.id });
      setTestResults((previous) => ({
        ...previous,
        [profile.id]: { ok: true, message: m['llm.testSuccess']({ latency: result.latencyMs }) },
      }));
    } catch (error) {
      setTestResults((previous) => ({
        ...previous,
        [profile.id]: { ok: false, message: errorText(error) },
      }));
    } finally {
      setBusy(false);
      setTesting(null);
    }
  }
  return (
    <div className="space-y-6">
    <ClassificationControls />
    <SettingsCard title={m['llm.title']()} description={m['llm.description']()}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={() => setEditing('new')}>
          <Plus className="size-4" />
          {m['llm.add']()}
        </Button>
        <LanguageSwitcher />
      </div>
      {list.isLoading && <p role="status">{m['common.actions.loading']()}</p>}
      {list.error && (
        <div role="alert">
          <p>{m['llm.operationFailed']()}</p>
          <Button variant="outline" onClick={() => void list.refetch()}>
            {m['pages.settings.retry']()}
          </Button>
        </div>
      )}
      {list.data && !list.data.ready && (
        <div role="status" className="rounded-lg border border-dashed p-4 text-sm">
          {m['llm.notConfigured']()}
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {list.data?.profiles.map((profile) => (
          <div
            key={profile.id}
            data-testid="llm-profile"
            className="space-y-3 rounded-lg border p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="truncate font-medium">
                {profile.source === 'environment' ? m['llm.environment']() : profile.name}
              </h2>
              {list.data.activeId === profile.id && (
                <Badge>
                  <Check className="mr-1 size-3" />
                  {m['llm.active']()}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground break-all text-sm">{profile.baseUrl}</p>
            <p className="break-all text-sm">
              {m['llm.model']()}：{profile.model}
            </p>
            <p className="text-muted-foreground text-xs">
              {profile.source === 'environment' ? m['llm.environmentHelp']() : m['llm.keySaved']()}
            </p>
            {testResults[profile.id] && (
              <p
                role={testResults[profile.id]!.ok ? 'status' : 'alert'}
                className={
                  testResults[profile.id]!.ok
                    ? 'text-sm text-green-700 dark:text-green-400'
                    : 'text-destructive text-sm'
                }
              >
                {testResults[profile.id]!.message}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void testProfile(profile)}
              >
                {testing === profile.id && <Loader2 className="size-4 animate-spin" />}
                {testing === profile.id ? m['llm.testingModel']() : m['llm.testModel']()}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    client.llm.activate.mutate({
                      id: list.data.activeId === profile.id ? null : profile.id,
                    }),
                  )
                }
              >
                {list.data.activeId === profile.id ? m['llm.deactivate']() : m['llm.activate']()}
              </Button>
              {profile.source !== 'environment' && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={`${m['llm.edit']()} ${profile.name}`}
                    onClick={() => setEditing(profile)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={`${m['llm.remove']()} ${profile.name}`}
                    onClick={() => setRemoving(profile)}
                  >
                    <Trash className="size-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <ProviderDialog
          profile={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            toast.success(m['llm.saved']());
          }}
        />
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent showOverlay>
          <DialogHeader>
            <DialogTitle>{m['llm.remove']()}</DialogTitle>
            <DialogDescription>{m['llm.removeHelp']()}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {m['common.actions.cancel']()}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                removing && void action(() => client.llm.remove.mutate({ id: removing.id }))
              }
            >
              {m['llm.remove']()}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsCard>
    </div>
  );
}

function ProviderDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile?: Profile;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const client = useTRPCClient(),
    formRef = useRef<HTMLFormElement>(null),
    inFlight = useRef(false);
  const [busy, setBusy] = useState<'save' | 'models' | 'test' | null>(null),
    [error, setError] = useState(''),
    [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(profile?.model || ''),
    [baseUrl, setBaseUrl] = useState(profile?.baseUrl || 'https://api.openai.com/v1');
  const [fetched, setFetched] = useState(false);
  const [testResult, setTestResult] = useState('');
  async function run(kind: 'save' | 'models' | 'test') {
    if (inFlight.current || !formRef.current) return;
    if (kind === 'save' && !formRef.current.reportValidity()) return;
    const fields = new FormData(formRef.current),
      value = (name: string) => String(fields.get(name) || '').trim();
    if (kind !== 'save') {
      for (const name of ['baseUrl', 'apiKey', ...(kind === 'test' ? ['model'] : [])]) {
        const field = formRef.current.elements.namedItem(name) as HTMLInputElement;
        if (!field.reportValidity()) return;
      }
    }
    inFlight.current = true;
    setBusy(kind);
    setError('');
    setTestResult('');
    try {
      // Direct client calls keep keys out of query/mutation caches and browser persistence.
      if (kind === 'models') {
        const result = await client.llm.models.mutate({
          id: profile?.id,
          baseUrl: value('baseUrl'),
          apiKey: value('apiKey') || undefined,
        });
        setModels(result.models);
        setFetched(true);
      } else if (kind === 'test') {
        const result = await client.llm.test.mutate({
          id: profile?.id,
          baseUrl: value('baseUrl'),
          apiKey: value('apiKey') || undefined,
          model: value('model'),
        });
        setTestResult(m['llm.testSuccess']({ latency: result.latencyMs }));
      } else {
        await client.llm.save.mutate({
          id: profile?.id,
          name: value('name'),
          baseUrl: value('baseUrl'),
          apiKey: value('apiKey') || undefined,
          model: value('model'),
          miniModel: value('miniModel'),
          embeddingModel: value('embeddingModel'),
          activate: fields.get('activate') === 'on',
        });
        formRef.current.reset();
        await onSaved();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent showOverlay className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{profile ? m['llm.edit']() : m['llm.add']()}</DialogTitle>
          <DialogDescription>{m['llm.formHelp']()}</DialogDescription>
        </DialogHeader>
        <form
          ref={formRef}
          onChange={() => {
            setTestResult('');
            setError('');
          }}
          className="mt-4 space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run('save');
          }}
        >
          <fieldset className="space-y-4" disabled={!!busy}>
            <label className="block space-y-1 text-sm">
              <span>{m['llm.name']()}</span>
              <Input name="name" required maxLength={100} defaultValue={profile?.name} />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Base URL (OPENAI_BASE_URL)</span>
              <Input
                name="baseUrl"
                type="url"
                required
                maxLength={2048}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setModels([]);
                  setFetched(false);
                }}
              />
              <span className="text-muted-foreground text-xs">
                {m['llm.urlHelp']()} {m['llm.localUrlHelp']()}
              </span>
            </label>
            <label className="block space-y-1 text-sm">
              <span>API Key</span>
              <Input
                name="apiKey"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                required={!profile || baseUrl.replace(/\/+$/, '') !== profile.baseUrl}
                placeholder={profile ? m['llm.keepKey']() : ''}
                onChange={() => {
                  setModels([]);
                  setFetched(false);
                }}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void run('models')}>
                {busy === 'models' && <Loader2 className="size-4 animate-spin" />}
                {m['llm.fetchModels']()}
              </Button>
              {fetched && (
                <span className="text-muted-foreground text-xs">
                  {m['llm.modelsLoaded']({ count: models.length })}
                </span>
              )}
            </div>
            {models.length > 0 && (
              <label className="block space-y-1 text-sm">
                <span>{m['llm.chooseModel']()}</span>
                <select
                  aria-label={m['llm.chooseModel']()}
                  className="bg-background h-9 w-full rounded-md border px-3"
                  value={models.includes(model) ? model : ''}
                  onChange={(event) => setModel(event.target.value)}
                >
                  <option value="" disabled>
                    {m['llm.chooseModel']()}
                  </option>
                  {models.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block space-y-1 text-sm">
              <span>{m['llm.model']()}</span>
              <Input
                name="model"
                required
                maxLength={256}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
              <span className="text-muted-foreground text-xs">{m['llm.manualModel']()}</span>
            </label>
            <div className="space-y-2">
              <Button type="button" variant="outline" onClick={() => void run('test')}>
                {busy === 'test' && <Loader2 className="size-4 animate-spin" />}
                {busy === 'test' ? m['llm.testingModel']() : m['llm.testModel']()}
              </Button>
              <p className="text-muted-foreground text-xs">{m['llm.testHelp']()}</p>
            </div>
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer">{m['connectionsUi.advanced']()}</summary>
              <div className="mt-3 space-y-3">
                <label className="block space-y-1">
                  <span>{m['llm.miniModel']()}</span>
                  <Input
                    name="miniModel"
                    maxLength={256}
                    defaultValue={profile?.miniModel}
                    placeholder={m['llm.sameModel']()}
                  />
                </label>
                <label className="block space-y-1">
                  <span>{m['llm.embeddingModel']()}</span>
                  <Input
                    name="embeddingModel"
                    maxLength={256}
                    defaultValue={profile?.embeddingModel}
                  />
                  <span className="text-muted-foreground text-xs">{m['llm.embeddingHelp']()}</span>
                </label>
              </div>
            </details>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="activate" defaultChecked />
              {m['llm.saveActivate']()}
            </label>
          </fieldset>
          {testResult && (
            <p role="status" className="text-sm text-green-700 dark:text-green-400">
              {testResult}
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={!!busy} onClick={onClose}>
              {m['common.actions.cancel']()}
            </Button>
            <Button type="submit" disabled={!!busy}>
              {busy === 'save' && <Loader2 className="size-4 animate-spin" />}
              {m['common.actions.saveChanges']()}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
