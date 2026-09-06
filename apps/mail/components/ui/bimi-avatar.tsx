import { useState, useCallback, useMemo, useEffect } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from './avatar';
import { useTRPC } from '@/providers/query-provider';
import { useQuery } from '@tanstack/react-query';
import { getEmailLogo } from '@/lib/utils';
import DOMPurify from 'dompurify';

export const getFirstLetterCharacter = (name?: string) => {
  if (!name) return '';
  const match = name.match(/[a-zA-Z]/);
  return match ? match[0].toUpperCase() : '';
};

interface BimiAvatarProps {
  email?: string;
  name?: string;
  className?: string;
  fallbackClassName?: string;
  onImageError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}

export const BimiAvatar = ({
  email,
  name,
  className = 'h-8 w-8 rounded-full border dark:border-none',
  fallbackClassName = 'rounded-full bg-[#FFFFFF] font-bold text-[#9F9F9F] dark:bg-[#373737]',
  onImageError,
}: BimiAvatarProps) => {
  const trpc = useTRPC();
  const [useDefaultFallback, setUseDefaultFallback] = useState(false);

  const domain = email?.split('@')[1]?.toLowerCase() || '';
  useEffect(() => setUseDefaultFallback(false), [email]);
  const { data: bimiData } = useQuery({
    ...trpc.bimi.getByDomain.queryOptions({ domain }),
    enabled: !!domain,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 60 * 24,
    retry: false,
    meta: { noGlobalError: true },
  });

  const fallbackImageSrc = useMemo(() => {
    if (useDefaultFallback || !email) return '';
    return getEmailLogo(email);
  }, [email, useDefaultFallback]);

  const handleFallbackImageError = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      setUseDefaultFallback(true);
      if (onImageError) {
        onImageError(e);
      }
    },
    [onImageError],
  );

  const firstLetter = getFirstLetterCharacter(name || email);

  if (!email) {
    return (
      <Avatar className={className}>
        <AvatarFallback className={fallbackClassName}>{firstLetter}</AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar className={className}>
      {bimiData?.logo?.svgContent ? (
        <div
          className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-white dark:bg-[#373737]"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bimiData.logo.svgContent) }}
        />
      ) : fallbackImageSrc && !useDefaultFallback ? (
        <AvatarImage
          className="rounded-full bg-[#FFFFFF] dark:bg-[#373737]"
          src={fallbackImageSrc}
          alt={name || email}
          onError={handleFallbackImageError}
        />
      ) : null}
      {!bimiData?.logo?.svgContent && (
        <AvatarFallback className={fallbackClassName}>{firstLetter}</AvatarFallback>
      )}
    </Avatar>
  );
};
