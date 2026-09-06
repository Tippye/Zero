import { useAutumn, useCustomer } from 'autumn-js/react';
import { isProCustomer } from '@/lib/utils';
import { useMemo } from 'react';

type FeatureState = {
  total: number;
  remaining: number;
  unlimited: boolean;
  enabled: boolean;
  usage: number;
  nextResetAt: number | null;
  interval: string;
  included_usage: number;
};

type Features = {
  chatMessages: FeatureState;
  connections: FeatureState;
  brainActivity: FeatureState;
};

const DEFAULT_FEATURES: Features = {
  chatMessages: {
    total: 0,
    remaining: 0,
    unlimited: false,
    enabled: false,
    usage: 0,
    nextResetAt: null,
    interval: '',
    included_usage: 0,
  },
  connections: {
    total: 0,
    remaining: 0,
    unlimited: false,
    enabled: false,
    usage: 0,
    nextResetAt: null,
    interval: '',
    included_usage: 0,
  },
  brainActivity: {
    total: 0,
    remaining: 0,
    unlimited: false,
    enabled: false,
    usage: 0,
    nextResetAt: null,
    interval: '',
    included_usage: 0,
  },
};

const FEATURE_IDS = {
  CHAT: 'chat-messages',
  CONNECTIONS: 'connections',
  BRAIN: 'brain-activity',
} as const;

const useHostedBilling = () => {
  const { customer, refetch, isLoading, error } = useCustomer();
  const { attach, track, openBillingPortal } = useAutumn();

  // Billing availability does not determine whether an auth session is valid.

  const { isPro, ...customerFeatures } = useMemo(() => {
    const isPro = customer ? isProCustomer(customer) : false;

    if (!customer?.features) return { isPro, ...DEFAULT_FEATURES };

    const features = { ...DEFAULT_FEATURES };

    if (customer.features[FEATURE_IDS.CHAT]) {
      const feature = customer.features[FEATURE_IDS.CHAT];
      features.chatMessages = {
        total: feature.included_usage || 0,
        remaining: feature.balance || 0,
        unlimited: feature.unlimited ?? false,
        enabled: (feature.unlimited ?? false) || Number(feature.balance) > 0,
        usage: feature.usage || 0,
        nextResetAt: feature.next_reset_at ?? null,
        interval: feature.interval || '',
        included_usage: feature.included_usage || 0,
      };
    }

    if (customer.features[FEATURE_IDS.CONNECTIONS]) {
      const feature = customer.features[FEATURE_IDS.CONNECTIONS];
      features.connections = {
        total: feature.included_usage || 0,
        remaining: feature.balance || 0,
        unlimited: feature.unlimited ?? false,
        enabled: (feature.unlimited ?? false) || Number(feature.balance) > 0,
        usage: feature.usage || 0,
        nextResetAt: feature.next_reset_at ?? null,
        interval: feature.interval || '',
        included_usage: feature.included_usage || 0,
      };
    }

    if (customer.features[FEATURE_IDS.BRAIN]) {
      const feature = customer.features[FEATURE_IDS.BRAIN];
      features.brainActivity = {
        total: feature.included_usage || 0,
        remaining: feature.balance || 0,
        unlimited: feature.unlimited ?? false,
        enabled: (feature.unlimited ?? false) || Number(feature.balance) > 0,
        usage: feature.usage || 0,
        nextResetAt: feature.next_reset_at ?? null,
        interval: feature.interval || '',
        included_usage: feature.included_usage || 0,
      };
    }

    return { isPro, ...features };
  }, [customer]);

  return {
    error,
    isLoading,
    customer,
    refetch,
    attach,
    track,
    openBillingPortal,
    isPro,
    ...customerFeatures,
  };
};

const useSelfHostedBilling = () => {
  const unrestricted = (feature: FeatureState): FeatureState => ({ ...feature, unlimited: true, enabled: true });
  const unavailable = async () => { throw new Error('自托管模式无需订阅。'); };
  return {
    error: null, isLoading: false, customer: null,
    refetch: async () => undefined,
    attach: unavailable, track: async () => undefined, openBillingPortal: unavailable,
    isPro: true,
    chatMessages: unrestricted(DEFAULT_FEATURES.chatMessages),
    connections: unrestricted(DEFAULT_FEATURES.connections),
    brainActivity: unrestricted(DEFAULT_FEATURES.brainActivity),
  };
};

// Mode is fixed at build time; each branch keeps its own stable hook sequence.
export const useBilling = import.meta.env.VITE_PUBLIC_SELF_HOSTED === 'true'
  ? useSelfHostedBilling : useHostedBilling;
