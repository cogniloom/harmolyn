import { useCallback, useRef } from 'react';
import { useToast } from '@/lib/toastBus';

/** Minimal shape satisfied by a React Query useMutation() result. */
interface MutationLike<TData, TVars> {
  mutateAsync: (vars: TVars) => Promise<TData>;
  isPending: boolean;
  isError: boolean;
}

interface FeedbackOptions<TData, TVars> {
  /** Durable "in-flight" toast text (string or fn of vars). Omit to show none. */
  loading?: string | ((vars: TVars) => string);
  /** Success toast text (string or fn of result+vars). Omit to silently dismiss. */
  success?: string | ((data: TData, vars: TVars) => string);
  /**
   * User-safe error text. Use a function only when the caller deliberately maps
   * internal failures to a bounded public message. Raw thrown error strings are
   * never surfaced automatically.
   */
  error?: string | ((err: unknown, vars: TVars) => string);
  /** Skip loading+success toasts; only surface errors. For high-frequency ops (reactions, pins). */
  silent?: boolean;
}

const DEFAULT_ERROR = 'That action could not be completed. Try again.';
const MAX_FEEDBACK_LENGTH = 300;

function boundedFeedback(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.length > MAX_FEEDBACK_LENGTH ? `${text.slice(0, MAX_FEEDBACK_LENGTH - 1)}…` : text;
}

/**
 * Wraps a mutation so every call shows the user what's happening: a durable
 * "loading" toast that flips in place to success/error on settle. Keeps any
 * optimistic local update the mutation already does — this only adds the
 * in-flight + outcome surface. `run(vars)` resolves to the data, or undefined on
 * error (it never throws, so call sites stay simple).
 *
 * Security boundary: thrown network/native/crypto errors may contain endpoints,
 * paths, peer identifiers, serialized payloads, or implementation details. They
 * are intentionally collapsed unless the caller provides an explicit public
 * mapping in `opts.error`.
 */
export function useMutationFeedback<TData, TVars>(
  mutation: MutationLike<TData, TVars>,
  opts: FeedbackOptions<TData, TVars> = {},
) {
  const toast = useToast();
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { mutateAsync } = mutation;

  const run = useCallback(async (vars: TVars): Promise<TData | undefined> => {
    const o = optsRef.current;
    const loadingRaw = typeof o.loading === 'function' ? o.loading(vars) : o.loading;
    const loadingMsg = loadingRaw ? boundedFeedback(loadingRaw, 'Working…') : '';
    const id = (!o.silent && loadingMsg) ? toast.loading(loadingMsg) : '';
    try {
      const data = await mutateAsync(vars);
      if (id) {
        const successRaw = typeof o.success === 'function' ? o.success(data, vars) : o.success;
        const successMsg = successRaw ? boundedFeedback(successRaw, 'Done') : '';
        if (successMsg) toast.update(id, { type: 'success', title: 'Done', body: successMsg, durable: false });
        else toast.dismiss(id);
      } else if (!o.silent && o.success) {
        const successRaw = typeof o.success === 'function' ? o.success(data, vars) : o.success;
        const successMsg = boundedFeedback(successRaw, 'Done');
        if (successMsg) toast.success(successMsg);
      }
      return data;
    } catch (err) {
      const explicit = typeof o.error === 'function' ? o.error(err, vars) : o.error;
      const errorMsg = boundedFeedback(explicit, DEFAULT_ERROR);
      if (id) toast.update(id, { type: 'error', title: 'Something went wrong', body: errorMsg, durable: false });
      else toast.error(errorMsg);
      return undefined;
    }
  }, [mutateAsync, toast]);

  return { run, isPending: mutation.isPending, isError: mutation.isError };
}
