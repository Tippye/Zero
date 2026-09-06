import { z } from 'zod';

export const serializedFileSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number(),
  lastModified: z.number(),
  base64: z.string(),
});

export const deserializeFiles = async (serializedFiles: z.infer<typeof serializedFileSchema>[]) => {
  return await Promise.all(
    serializedFiles.map((data) => {
      const file = Buffer.from(data.base64, 'base64');
      const blob = new Blob([file], { type: data.type });
      const newFile = new File([blob], data.name, {
        type: data.type,
        lastModified: data.lastModified,
      });
      return newFile;
    }),
  );
};

export const createDraftData = z.object({
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  message: z.string(),
  attachments: z.array(serializedFileSchema).optional(),
  id: z.string().nullable(),
  threadId: z.string().nullable(),
  fromEmail: z.string().nullable(),
});

export type CreateDraftData = z.infer<typeof createDraftData>;

export const mailCategorySchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-zA-Z0-9\-_ ]+$/,
      'Category ID must contain only alphanumeric characters, hyphens, underscores, and spaces',
    ),
  builtin: z.enum(['primary', 'transactions', 'updates', 'promotions', 'all']).optional(),
  name: z.string(),
  searchValue: z.string(),
  order: z.number().int(),
  icon: z.string().optional(),
  isDefault: z.boolean().optional().default(false),
});

export type MailCategory = z.infer<typeof mailCategorySchema>;

export const defaultMailCategories: MailCategory[] = [
  { id: 'zero-primary', builtin: 'primary', name: 'Primary', searchValue: 'ZERO_CATEGORY_PRIMARY', order: 0, icon: 'Inbox', isDefault: false },
  { id: 'zero-transactions', builtin: 'transactions', name: 'Transactions', searchValue: 'ZERO_CATEGORY_TRANSACTIONS', order: 1, icon: 'Receipt', isDefault: false },
  { id: 'zero-updates', builtin: 'updates', name: 'Updates', searchValue: 'ZERO_CATEGORY_UPDATES', order: 2, icon: 'Bell', isDefault: false },
  { id: 'zero-promotions', builtin: 'promotions', name: 'Promotions', searchValue: 'ZERO_CATEGORY_PROMOTIONS', order: 3, icon: 'Tags', isDefault: false },
  { id: 'zero-all', builtin: 'all', name: 'All', searchValue: '', order: 4, icon: 'Mails', isDefault: true },
];

// Upgrade the old defaults once, without interpreting user-defined names as translation keys.
export function normalizeMailCategories(categories?: MailCategory[]): MailCategory[] {
  if (categories?.some(c => c.builtin)) return [...categories].sort((a, b) => a.order - b.order);
  const legacy: Record<string, string> = { Important: 'IMPORTANT', 'All Mail': '', Unread: 'UNREAD' };
  const custom = (categories || []).filter(c => !(c.id === c.name && Object.hasOwn(legacy, c.id) && legacy[c.id] === c.searchValue));
  const customDefault = custom.some(c => c.isDefault);
  const defaults = defaultMailCategories.filter(c => !custom.some(item => item.id === c.id));
  return [...defaults.map(c => ({ ...c, isDefault: customDefault ? false : c.isDefault })), ...custom]
    .map((c, order) => ({ ...c, order }));
}

const categoriesSchema = z.array(mailCategorySchema).superRefine((cats, ctx) => {
  const orders = cats.map((c) => c.order);
  if (new Set(orders).size !== orders.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Each mail category must have a unique order number',
    });
  }

  const defaultCount = cats.filter((c) => c.isDefault).length;
  if (defaultCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Exactly one mail category must be set as default',
    });
  }
});

export const userSettingsSchema = z.object({
  language: z.string(),
  timezone: z.string(),
  dynamicContent: z.boolean().optional(),
  externalImages: z.boolean(),
  customPrompt: z.string().default(''),
  isOnboarded: z.boolean().optional(),
  trustedSenders: z.string().array().optional(),
  colorTheme: z.enum(['light', 'dark', 'system']).default('system'),
  zeroSignature: z.boolean().default(true),
  categories: categoriesSchema.optional(),
  defaultEmailAlias: z.string().optional(),
  undoSendEnabled: z.boolean().default(false),
  imageCompression: z.enum(['low', 'medium', 'original']).default('medium'),
  aiCategoryLearning: z.boolean().default(false),
  autoRead: z.boolean().default(true),
  animations: z.boolean().default(false),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const defaultUserSettings: UserSettings = {
  language: 'en',
  timezone: 'UTC',
  dynamicContent: false,
  externalImages: true,
  customPrompt: '',
  trustedSenders: [],
  isOnboarded: false,
  colorTheme: 'system',
  zeroSignature: true,
  aiCategoryLearning: false,
  autoRead: true,
  defaultEmailAlias: '',
  categories: defaultMailCategories,
  undoSendEnabled: false,
  imageCompression: 'medium',
  animations: false,
};
