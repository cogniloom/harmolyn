import { readShellRuntimeData } from '@/data';
import type { User } from '@/types';

export interface ForwardDestination {
  id: string;
  label: string;
  sublabel: string;
  type: 'channel' | 'dm';
}

const UNKNOWN_CHAT_USER_LABEL = 'Unknown User';

export function buildForwardDestinations(
  liveShellData: ReturnType<typeof readShellRuntimeData>,
  normalizedUsers: User[],
): ForwardDestination[] {
  const dmDestinations = liveShellData.directMessages.map((dm) => {
    const destinationUser = normalizedUsers.find((user) => user.id === dm.userId);
    return {
      id: dm.id,
      label: destinationUser?.username || UNKNOWN_CHAT_USER_LABEL,
      sublabel: 'Direct Message',
      type: 'dm' as const,
    };
  });

  const channelDestinations = liveShellData.servers.flatMap((server) =>
    server.categories.flatMap((category) =>
      category.channels
        .filter((entry) => entry.type === 'text')
        .map((entry) => ({
          id: entry.id,
          label: entry.name,
          sublabel: server.name,
          type: 'channel' as const,
        })),
    ),
  );

  return [...dmDestinations, ...channelDestinations]
    .filter((destination, index, values) => values.findIndex((candidate) => candidate.id === destination.id) === index)
    .sort((left, right) => left.label.localeCompare(right.label));
}
