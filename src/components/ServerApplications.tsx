
import React, { useEffect, useState } from 'react';
import { X, FileText, Plus, Trash2, GripVertical, CheckCircle2, Clock, XCircle, ChevronDown, ChevronUp, Users } from 'lucide-react';
import { usePersistentState } from '@/hooks/usePersistentState';
import { PREVIEW_STORAGE_KEYS } from '@/config/storageKeys';

interface ApplicationQuestion {
  id: string;
  question: string;
  type: 'text' | 'textarea' | 'select';
  required: boolean;
  options?: string[];
}

interface Application {
  id: string;
  userId: string;
  username: string;
  avatar: string;
  status: 'pending' | 'approved' | 'rejected';
  submittedAt: string;
  answers: { questionId: string; answer: string }[];
}

const DEFAULT_QUESTIONS: ApplicationQuestion[] = [
  { id: 'q1', question: 'Why do you want to join this server?', type: 'textarea', required: true },
  { id: 'q2', question: 'How did you find us?', type: 'select', required: true, options: ['Search', 'Friend referral', 'Social media', 'Other'] },
  { id: 'q3', question: 'Do you agree to follow our rules?', type: 'select', required: true, options: ['Yes', 'No'] },
];


type Tab = 'review' | 'form';

interface FeedbackState {
  tone: 'error' | 'info' | 'success';
  message: string;
}

interface ServerApplicationsProps {
  serverId: string;
  onClose: () => void;
}

export const ServerApplications: React.FC<ServerApplicationsProps> = ({ serverId, onClose }) => {
  const baseKey = PREVIEW_STORAGE_KEYS.serverApplications(serverId);
  const [tab, setTab] = useState<Tab>('review');
  const [applications, setApplications] = usePersistentState<Application[]>(`${baseKey}:apps`, []);
  const [questions, setQuestions] = usePersistentState<ApplicationQuestion[]>(`${baseKey}:questions`, DEFAULT_QUESTIONS);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);

  const filtered = filter === 'all' ? applications : applications.filter(a => a.status === filter);
  const pendingCount = applications.filter(a => a.status === 'pending').length;

  useEffect(() => {
    if (!feedback) {
      return;
    }

    const timer = window.setTimeout(() => setFeedback(null), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const handleAction = (appId: string, action: 'approved' | 'rejected') => {
    setApplications(prev => prev.map(a => a.id === appId ? { ...a, status: action } : a));
    setFeedback({
      tone: action === 'approved' ? 'success' : 'info',
      message: action === 'approved'
        ? 'Application approved.'
        : 'Application rejected.',
    });
  };

  const addQuestion = () => {
    const id = `q-${Date.now()}`;
    setQuestions(prev => [...prev, { id, question: `Custom question ${prev.length + 1}`, type: 'text', required: false }]);
    setFeedback({ tone: 'success', message: 'Application question added.' });
  };

  const removeQuestion = (id: string) => {
    if (questions.length === 1) {
      setFeedback({ tone: 'info', message: 'At least one application question is required.' });
      return;
    }

    setQuestions(prev => prev.filter(q => q.id !== id));
    setFeedback({ tone: 'info', message: 'Application question removed.' });
  };

  const statusConfig = {
    pending: { color: 'text-accent-warning', bg: 'bg-accent-warning/15', border: 'border-accent-warning/20', icon: <Clock size={12} /> },
    approved: { color: 'text-accent-success', bg: 'bg-accent-success/15', border: 'border-accent-success/20', icon: <CheckCircle2 size={12} /> },
    rejected: { color: 'text-accent-danger', bg: 'bg-accent-danger/15', border: 'border-accent-danger/20', icon: <XCircle size={12} /> },
  };

  return (
    <div className="absolute inset-0 z-[100] bg-bg-0 flex flex-col animate-in fade-in duration-200">
      {/* Header */}
      <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between flex-shrink-0">
        <div>
          <h2 className="text-lg font-bold text-white font-display tracking-tight">APPLICATIONS</h2>
          <p className="micro-label text-white/30 mt-1">MEMBER // SCREENING // GATEWAY</p>
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-accent-warning/15 text-accent-warning text-[10px] font-bold border border-accent-warning/20">
              {pendingCount} PENDING
            </span>
          )}
          <button onClick={onClose} className="w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary hover:shadow-glow-sm transition-all">
            <X size={18} className="text-white/60" />
          </button>
        </div>
      </div>

      {feedback && (
        <div className={`mx-6 mt-4 rounded-r2 border px-4 py-3 text-xs ${feedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : feedback.tone === 'success' ? 'border-accent-success/30 bg-accent-success/10 text-accent-success' : 'border-primary/30 bg-primary/10 text-primary'}`}>
          {feedback.message}
        </div>
      )}

      {/* Tabs */}
      <div className="px-6 py-3 border-b border-white/5 flex gap-2 flex-shrink-0">
        {[
          { id: 'review' as Tab, label: 'Review Applications', icon: <Users size={14} /> },
          { id: 'form' as Tab, label: 'Form Builder', icon: <FileText size={14} /> },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold border transition-all ${
              tab === t.id
                ? 'bg-primary/15 border-primary/30 text-primary'
                : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 no-scrollbar">
        <div className="max-w-[700px] mx-auto">
          {tab === 'review' ? (
            <>
              {/* Filters */}
              <div className="flex gap-2 mb-5">
                {(['all', 'pending', 'approved', 'rejected'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
                      filter === f
                        ? 'bg-primary/15 border-primary/30 text-primary'
                        : 'bg-white/3 border-white/5 text-white/30 hover:bg-white/5'
                    }`}
                  >
                    {f} {f !== 'all' ? `(${applications.filter(a => a.status === f).length})` : ''}
                  </button>
                ))}
              </div>

              {/* Application List */}
              <div className="space-y-3">
                {filtered.map(app => {
                  const sc = statusConfig[app.status];
                  const expanded = expandedApp === app.id;
                  return (
                    <div key={app.id} className="glass-card rounded-r2 border border-white/5 hover:border-white/10 transition-all overflow-hidden">
                      <div
                        className="p-4 flex items-center gap-3 cursor-pointer"
                        onClick={() => setExpandedApp(expanded ? null : app.id)}
                      >
                        <img src={app.avatar} className="w-10 h-10 rounded-full border border-white/10" alt={app.username} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold text-white">{app.username}</div>
                          <div className="text-[9px] font-mono text-white/20">{app.submittedAt}</div>
                        </div>
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider ${sc.bg} ${sc.color} border ${sc.border}`}>
                          {sc.icon} {app.status}
                        </span>
                        {expanded ? <ChevronUp size={14} className="text-white/20" /> : <ChevronDown size={14} className="text-white/20" />}
                      </div>

                      {expanded && (
                        <div className="px-4 pb-4 border-t border-white/5 pt-3 space-y-3 animate-in slide-in-from-top-2 duration-200">
                          {app.answers.map(ans => {
                            const q = DEFAULT_QUESTIONS.find(qu => qu.id === ans.questionId);
                            return (
                              <div key={ans.questionId}>
                                <div className="micro-label text-white/30 mb-1">{q?.question || 'Unknown'}</div>
                                <div className="text-sm text-white/70 bg-surface-dark rounded-r1 px-3 py-2 border border-white/5">{ans.answer}</div>
                              </div>
                            );
                          })}

                          {app.status === 'pending' && (
                            <div className="flex gap-2 pt-2">
                              <button onClick={() => handleAction(app.id, 'approved')} className="flex-1 py-2.5 rounded-full bg-accent-success text-bg-0 font-bold text-xs flex items-center justify-center gap-1.5 hover:shadow-[0_0_15px_rgba(5,255,161,0.3)] transition-all">
                                <CheckCircle2 size={14} /> APPROVE
                              </button>
                              <button onClick={() => handleAction(app.id, 'rejected')} className="flex-1 py-2.5 rounded-full bg-accent-danger text-white font-bold text-xs flex items-center justify-center gap-1.5 hover:shadow-[0_0_15px_rgba(255,42,109,0.3)] transition-all">
                                <XCircle size={14} /> REJECT
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {filtered.length === 0 && (
                  <div className="text-center py-16">
                    <Users size={32} className="mx-auto text-white/10 mb-3" />
                    <p className="text-xs text-white/20">No applications found</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="micro-label text-white/30 mb-4">APPLICATION FORM QUESTIONS</div>
              <div className="space-y-3 mb-5">
                {questions.map((q, idx) => (
                  <div key={q.id} className="glass-card rounded-r2 p-4 border border-white/5 group">
                    <div className="flex items-start gap-3">
                      <GripVertical size={16} className="text-white/10 mt-1 cursor-grab" />
                      <div className="flex-1 space-y-2">
                          <input
                            value={q.question}
                            onChange={e => setQuestions(prev => prev.map(qu => qu.id === q.id ? { ...qu, question: e.target.value } : qu))}
                            placeholder={`Question ${idx + 1}...`}
                            className="w-full bg-transparent text-sm text-white font-bold placeholder:text-white/20 focus:outline-none"
                          />
                        <div className="flex items-center gap-2">
                          <select
                            value={q.type}
                            onChange={e => setQuestions(prev => prev.map(qu => qu.id === q.id ? { ...qu, type: e.target.value as typeof q.type } : qu))}
                            className="bg-surface-dark text-[10px] text-white/40 px-2 py-1 rounded-full border border-white/5 focus:outline-none"
                          >
                            <option value="text">Short Text</option>
                            <option value="textarea">Long Text</option>
                            <option value="select">Multiple Choice</option>
                          </select>
                          <label className="flex items-center gap-1 text-[10px] text-white/30 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={q.required}
                              onChange={e => setQuestions(prev => prev.map(qu => qu.id === q.id ? { ...qu, required: e.target.checked } : qu))}
                              className="accent-primary"
                            />
                            Required
                          </label>
                        </div>
                      </div>
                      <button onClick={() => removeQuestion(q.id)} className="p-1.5 rounded-full hover:bg-accent-danger/10 text-white/20 hover:text-accent-danger transition-all opacity-0 group-hover:opacity-100">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button onClick={addQuestion} className="w-full py-3 rounded-r2 border border-dashed border-white/10 text-white/30 text-xs font-bold hover:border-primary/30 hover:text-primary hover:bg-primary/5 transition-all flex items-center justify-center gap-2">
                <Plus size={14} /> ADD QUESTION
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
