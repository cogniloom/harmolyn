
import React, { useState } from 'react';
import { CheckCircle2, Circle, ChevronRight, MessageSquare, UserPlus, Bell, Smile, X } from 'lucide-react';

interface GuideTask {
  id: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  completed?: boolean;
}

const GUIDE_TASKS: GuideTask[] = [
  { id: 'g1', title: 'Send your first message', description: 'Say hello in #general to introduce yourself', icon: <MessageSquare size={16} />, completed: true },
  { id: 'g2', title: 'Add a profile picture', description: 'Personalize your account with an avatar', icon: <Smile size={16} />, completed: true },
  { id: 'g3', title: 'Add a friend', description: 'Connect with other members of the community', icon: <UserPlus size={16} /> },
  { id: 'g4', title: 'Set notification preferences', description: 'Customize how you receive alerts from this server', icon: <Bell size={16} /> },
];

interface ServerGuideProps {
  serverName: string;
  onClose: () => void;
  onTaskClick?: (taskId: string) => void;
}

export const ServerGuide: React.FC<ServerGuideProps> = ({ serverName, onClose, onTaskClick }) => {
  const [tasks, setTasks] = useState(GUIDE_TASKS);

  const completedCount = tasks.filter(t => t.completed).length;
  const progress = (completedCount / tasks.length) * 100;

  const handleToggle = (id: string) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
    onTaskClick?.(id);
  };

  return (
    <div className="absolute inset-0 z-[110] bg-bg-0/95 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="glass-card rounded-r3 border border-white/10 w-full max-w-[460px] shadow-2xl">
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white font-display tracking-tight">SERVER GUIDE</h2>
            <p className="micro-label text-white/30 mt-1">{serverName.toUpperCase()} // GETTING STARTED</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full border border-white/10 flex items-center justify-center hover:border-primary transition-all">
            <X size={14} className="text-white/40" />
          </button>
        </div>

        {/* Progress */}
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-white">{completedCount}/{tasks.length} completed</span>
            <span className="text-[10px] font-mono text-white/30">{Math.round(progress)}%</span>
          </div>
          <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Tasks */}
        <div className="px-6 pb-6 space-y-2">
          {tasks.map(task => (
            <button
              key={task.id}
              onClick={() => handleToggle(task.id)}
              className={`w-full flex items-center gap-3 p-3 rounded-r2 border transition-all text-left group ${
                task.completed
                  ? 'border-accent-success/10 bg-accent-success/5'
                  : 'border-white/5 hover:border-primary/20 hover:bg-white/[0.02]'
              }`}
            >
              <div className="flex-shrink-0">
                {task.completed ? (
                  <CheckCircle2 size={20} className="text-accent-success" />
                ) : (
                  <Circle size={20} className="text-white/20 group-hover:text-primary/40" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-bold ${task.completed ? 'text-white/40 line-through' : 'text-white'}`}>{task.title}</div>
                <div className="text-[10px] text-white/30">{task.description}</div>
              </div>
              <div className="text-white/10 group-hover:text-white/20">
                {task.icon}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
