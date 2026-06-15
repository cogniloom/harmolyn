
import React, { useState } from 'react';
import { X, ChevronRight, ChevronLeft, Hash, Bell, Shield, Sparkles, Check, Users } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  options?: { id: string; label: string; description: string; selected?: boolean }[];
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to the Server!',
    description: 'Let\'s get you set up. We\'ll walk you through a few things to customize your experience.',
    icon: <Sparkles size={32} />,
  },
  {
    id: 'channels',
    title: 'Pick Your Channels',
    description: 'Choose which channels you want to see. You can always change this later.',
    icon: <Hash size={32} />,
    options: [
      { id: 'general', label: '#general', description: 'Main chat for everyone', selected: true },
      { id: 'announcements', label: '#announcements', description: 'Important server updates', selected: true },
      { id: 'gaming', label: '#gaming', description: 'Game discussions and LFG' },
      { id: 'music', label: '#music', description: 'Share and discuss music' },
      { id: 'art', label: '#art', description: 'Creative works and feedback' },
      { id: 'tech', label: '#tech', description: 'Technology and programming' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notification Preferences',
    description: 'How do you want to be notified about activity in this server?',
    icon: <Bell size={32} />,
    options: [
      { id: 'all', label: 'All Messages', description: 'Get notified for everything' },
      { id: 'mentions', label: 'Mentions Only', description: 'Only @mentions and DMs', selected: true },
      { id: 'none', label: 'Nothing', description: 'Mute this server completely' },
    ],
  },
  {
    id: 'rules',
    title: 'Server Rules',
    description: 'Please review and accept the community guidelines before proceeding.',
    icon: <Shield size={32} />,
    options: [
      { id: 'r1', label: 'Be respectful to all members', description: 'No harassment, hate speech, or personal attacks' },
      { id: 'r2', label: 'No spam or self-promotion', description: 'Keep content relevant to the channel topic' },
      { id: 'r3', label: 'Follow Discord ToS', description: 'All Discord Terms of Service apply here' },
    ],
  },
];

interface OnboardingWizardProps {
  serverName: string;
  onComplete: () => void;
  onClose: () => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ serverName, onComplete, onClose }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});

  const step = ONBOARDING_STEPS[currentStep];
  const totalSteps = ONBOARDING_STEPS.length;
  const isLast = currentStep === totalSteps - 1;
  const isFirst = currentStep === 0;

  useEscapeKey(onClose);

  const toggleSelection = (stepId: string, optionId: string) => {
    setSelections(prev => {
      const current = prev[stepId] || [];
      return {
        ...prev,
        [stepId]: current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId],
      };
    });
  };

  const isSelected = (stepId: string, optionId: string) => {
    return (selections[stepId] || []).includes(optionId);
  };

  return (
    <div className="absolute inset-0 z-[110] bg-bg-0/95 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in duration-300">
      <div role="dialog" aria-modal="true" aria-labelledby="onboarding-wizard-title" className="glass-card rounded-r3 border border-white/10 w-full max-w-[520px] shadow-2xl overflow-hidden">
        {/* Progress */}
        <div className="h-1 bg-white/5">
          <div
            className="h-full bg-primary transition-all duration-500"
            style={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }}
          />
        </div>

        {/* Header */}
        <div className="px-8 pt-8 pb-4 text-center">
          <div className="micro-label text-primary/70 mb-3" aria-live="polite">
            Step {currentStep + 1} of {totalSteps}
          </div>
          <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4 text-primary">
            {step.icon}
          </div>
          <h2 id="onboarding-wizard-title" className="text-xl font-bold text-white font-display tracking-tight mb-2">{step.title}</h2>
          <p className="text-sm text-white/40">{step.description}</p>
        </div>

        {/* Options */}
        {step.options && (
          <div className="px-8 pb-4 space-y-2 max-h-[300px] overflow-y-auto no-scrollbar">
            {step.options.map(opt => {
              const selected = isSelected(step.id, opt.id) || opt.selected;
              return (
                <button
                  key={opt.id}
                  onClick={() => toggleSelection(step.id, opt.id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-r2 border transition-all text-left ${
                    selected
                      ? 'bg-primary/10 border-primary/20'
                      : 'border-white/5 hover:bg-white/5'
                  }`}
                >
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                    selected ? 'border-primary bg-primary' : 'border-white/20'
                  }`}>
                    {selected && <Check size={12} className="text-bg-0" />}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white">{opt.label}</div>
                    <div className="text-[10px] text-white/35">{opt.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Navigation */}
        <div className="px-8 pb-8 pt-4 flex items-center justify-between">
          <button
            onClick={isFirst ? onClose : () => setCurrentStep(s => s - 1)}
            className="focus-ring flex items-center gap-1.5 px-4 py-2.5 rounded-full border border-white/10 text-white/40 text-xs font-bold hover:bg-white/5 transition-all"
          >
            {isFirst ? <X size={14} /> : <ChevronLeft size={14} />}
            {isFirst ? 'SKIP' : 'BACK'}
          </button>

          <div className="flex gap-1.5" aria-hidden="true">
            {ONBOARDING_STEPS.map((_, i) => (
              <div key={i} className={`w-2 h-2 rounded-full transition-all ${i === currentStep ? 'bg-primary scale-125' : i < currentStep ? 'bg-primary/40' : 'bg-white/10'}`} />
            ))}
          </div>

          <button
            onClick={isLast ? onComplete : () => setCurrentStep(s => s + 1)}
            className="focus-ring flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-primary text-bg-0 text-xs font-bold hover:shadow-glow-sm transition-all"
          >
            {isLast ? 'FINISH' : 'NEXT'}
            {!isLast && <ChevronRight size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
};
