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
  /** Error toast text. Defaults to the thrown error's message. */
  error?: string | ((err: unknown, vars: TVars) => string);
  /** Skip loading+success toasts; only surface errors. For high-frequency ops (reactions, pins). */
  silent?: boolean;
}

/**
 * Wraps a mutation so every call shows the user what's happening: a durable
 * "loading" toast that flips in place to success/error on settle. Keeps any
 * optimistic local update the mutation already does — this only adds the
 * in-flight + outcome surface. `run(vars)` resolves to the data, or undefined on
 * error (it never throws, so call sites stay simple).
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
    const loadingMsg = typeof o.loading === 'function' ? o.loading(vars) : o.loading;
    const id = (!o.silent && loadingMsg) ? toast.loading(loadingMsg) : '';
    try {
      const data = await mutateAsync(vars);
      if (id) {
        const successMsg = typeof o.success === 'function' ? o.success(data, vars) : o.success;
        if (successMsg) toast.update(id, { type: 'success', title: 'Done', body: successMsg, durable: false });
        else toast.dismiss(id);
      } else if (!o.silent && o.success) {
        const successMsg = typeof o.success === 'function' ? o.success(data, vars) : o.success;
        if (successMsg) toast.success(successMsg);
      }
      return data;
    } catch (err) {
      const errorMsg = (typeof o.error === 'function' ? o.error(err, vars) : o.error)
        ?? (err instanceof Error ? err.message : 'Something went wrong');
      if (id) toast.update(id, { type: 'error', title: 'Something went wrong', body: errorMsg, durable: false });
      else toast.error(errorMsg);
      return undefined;
    }
  }, [mutateAsync, toast]);

  return { run, isPending: mutation.isPending, isError: mutation.isError };
}
