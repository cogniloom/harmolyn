
import React from 'react';

/** Skeleton loading placeholder with shimmer animation */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse bg-white/5 rounded-r1 ${className}`} />
);

/** Message skeleton */
export const MessageSkeleton: React.FC = () => (
  <div className="flex gap-5 p-2.5 animate-pulse">
    <Skeleton className="w-11 h-11 rounded-r2 flex-shrink-0" />
    <div className="flex-1 space-y-2.5 py-1">
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-3 w-24 rounded-full" />
        <Skeleton className="h-2.5 w-12 rounded-full" />
      </div>
      <Skeleton className="h-3 w-3/4 rounded-full" />
      <Skeleton className="h-3 w-1/2 rounded-full" />
    </div>
  </div>
);

/** Channel list skeleton */
export const ChannelSkeleton: React.FC = () => (
  <div className="space-y-4 px-3 py-5 animate-pulse">
    <div className="space-y-1.5">
      <Skeleton className="h-2.5 w-20 rounded-full mx-2 mb-3" />
      {[1, 2, 3, 4].map(i => (
        <Skeleton key={i} className="h-8 w-full rounded-r2" />
      ))}
    </div>
    <div className="space-y-1.5">
      <Skeleton className="h-2.5 w-16 rounded-full mx-2 mb-3" />
      {[1, 2].map(i => (
        <Skeleton key={i} className="h-8 w-full rounded-r2" />
      ))}
    </div>
  </div>
);

/** Member list skeleton */
export const MemberSkeleton: React.FC = () => (
  <div className="space-y-5 p-5 animate-pulse">
    <div className="space-y-1.5">
      <Skeleton className="h-2.5 w-24 rounded-full mx-2 mb-3" />
      {[1, 2, 3].map(i => (
        <div key={i} className="flex items-center gap-2.5 px-2.5 py-1.5">
          <Skeleton className="w-[26px] h-[26px] rounded-r1 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-20 rounded-full" />
            <Skeleton className="h-2 w-12 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  </div>
);
