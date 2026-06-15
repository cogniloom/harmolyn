import React from 'react';
import { ShieldCheck, ChevronDown } from 'lucide-react';

type SecurityNoteTone = 'info' | 'caution';

interface SecurityNoteProps {
  children: React.ReactNode;
  /** `info` for neutral guidance, `caution` for a privacy/trust trade-off worth a second thought. */
  tone?: SecurityNoteTone;
  icon?: React.ReactNode;
  className?: string;
  /**
   * Optional extra explanation revealed behind a self-contained "Learn more"
   * toggle. Lets a dense note start as a one-liner and expand on demand,
   * countering banner blindness without leaving the component or fetching docs.
   */
  details?: React.ReactNode;
}

const TONE_CLASSES: Record<SecurityNoteTone, string> = {
  info: 'border-primary/15 bg-primary/5 text-white/55',
  caution: 'border-accent-warning/25 bg-accent-warning/5 text-accent-warning/90',
};

/**
 * Small, non-obstructive inline note that helps the user make a conscious
 * security/privacy choice at the point of decision. Intentionally quiet:
 * it informs without blocking or nagging.
 */
export const SecurityNote: React.FC<SecurityNoteProps> = ({
  children,
  tone = 'info',
  icon,
  className = '',
  details,
}) => {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div
      className={`flex items-start gap-2.5 rounded-r2 border px-3.5 py-2.5 text-[11px] leading-relaxed ${TONE_CLASSES[tone]} ${className}`}
    >
      <span className="mt-0.5 shrink-0 opacity-80" aria-hidden="true">
        {icon ?? <ShieldCheck size={13} />}
      </span>
      <span className="min-w-0 flex-1">
        {children}
        {details != null && (
          <>
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="focus-ring mt-1.5 inline-flex items-center gap-1 rounded-r1 font-semibold text-current underline-offset-2 opacity-80 hover:opacity-100 transition-opacity"
            >
              {expanded ? 'Show less' : 'Learn more'}
              <ChevronDown
                size={12}
                className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {expanded && <div className="mt-1.5 opacity-90">{details}</div>}
          </>
        )}
      </span>
    </div>
  );
};
