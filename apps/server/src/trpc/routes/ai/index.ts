import { compose, generateEmailSubject } from './compose';
import { generateSearchQuery } from './search';
import { read, translation } from './read';
import { webSearch } from './webSearch';
import { router } from '../../trpc';

export const aiRouter = router({
  read,
  translation,
  generateSearchQuery,
  compose,
  generateEmailSubject,
  webSearch,
});
