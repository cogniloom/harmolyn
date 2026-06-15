
import React, { useState } from 'react';
import { Phone, PhoneOff, Video, VideoOff, Mic, MicOff, Monitor, Maximize2, Minimize2 } from 'lucide-react';
import { User } from '@/types';

interface DMCallControlsProps {
  recipientUser: User;
  onEndCall: () => void;
}

export const DMCallControls: React.FC<DMCallControlsProps> = ({ recipientUser, onEndCall }) => {
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [callDuration, setCallDuration] = useState('00:00');

  // Simulate call timer
  React.useEffect(() => {
    let seconds = 0;
    const timer = setInterval(() => {
      seconds++;
      const m = Math.floor(seconds / 60).toString().padStart(2, '0');
      const s = (seconds % 60).toString().padStart(2, '0');
      setCallDuration(`${m}:${s}`);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className={`flex flex-col ${isFullscreen ? 'fixed inset-0 z-[200]' : 'w-full'} bg-bg-0/95 backdrop-blur-xl`}>
      {/* Video Area */}
      <div className="flex-1 relative flex items-center justify-center min-h-[300px]">
        {/* Background pattern */}
        <div className="absolute inset-0 grid-overlay opacity-10" />

        {/* Remote user */}
        <div className="flex flex-col items-center gap-4 relative z-10">
          <div className="relative">
            <img
              src={recipientUser.avatar}
              className={`w-24 h-24 rounded-full border-2 ${isVideoOn ? 'border-primary shadow-glow' : 'border-white/10'}`}
              alt={recipientUser.username}
            />
            {/* Audio ring animation */}
            <div className="absolute inset-0 rounded-full border-2 border-primary/30 animate-ping opacity-30" />
          </div>
          <div className="text-center">
            <h3 className="text-lg font-bold text-white font-display">{recipientUser.username}</h3>
            <div className="flex items-center gap-2 justify-center mt-1">
              <div className="w-2 h-2 rounded-full bg-accent-success animate-pulse" />
              <span className="text-xs font-mono text-white/50">{callDuration}</span>
            </div>
          </div>
        </div>

        {/* Self preview (small) */}
        {isVideoOn && (
          <div className="absolute bottom-4 right-4 w-32 h-24 bg-bg-1 rounded-r1 border border-white/10 overflow-hidden shadow-xl">
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[9px] text-white/30 font-mono">CAMERA FEED</span>
            </div>
          </div>
        )}

        {/* Fullscreen toggle */}
        <button
          onClick={() => setIsFullscreen(!isFullscreen)}
          className="absolute top-4 right-4 p-2 text-white/30 hover:text-white/60 transition-colors"
          aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>

        {/* Connection info */}
        <div className="absolute top-4 left-4 flex items-center gap-2">
          <div className="px-2.5 py-1 rounded-full bg-accent-success/10 border border-accent-success/20">
            <span className="text-[9px] font-bold text-accent-success tracking-wider">ENCRYPTED // P2P</span>
          </div>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="px-6 py-5 border-t border-white/5 flex items-center justify-center gap-4">
        <CallButton
          active={!isMuted}
          icon={isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          label={isMuted ? 'Unmute' : 'Mute'}
          onClick={() => setIsMuted(!isMuted)}
        />
        <CallButton
          active={isVideoOn}
          icon={isVideoOn ? <Video size={20} /> : <VideoOff size={20} />}
          label={isVideoOn ? 'Turn off Video' : 'Turn on Video'}
          onClick={() => setIsVideoOn(!isVideoOn)}
          accent
        />
        <CallButton
          active={isScreenSharing}
          icon={<Monitor size={20} />}
          label={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          onClick={() => setIsScreenSharing(!isScreenSharing)}
        />
        <button
          onClick={onEndCall}
          className="w-14 h-14 rounded-full bg-accent-danger flex items-center justify-center text-white hover:bg-accent-danger/80 transition-all shadow-[0_0_20px_rgba(255,42,109,0.3)]"
          aria-label="End Call"
        >
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
};

const CallButton = ({ active, icon, label, onClick, accent = false }: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  accent?: boolean;
}) => (
  <button
    onClick={onClick}
    className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border ${
      active
        ? accent
          ? 'bg-primary/20 text-primary border-primary/30 shadow-glow-sm'
          : 'bg-white/10 text-white border-white/10'
        : 'bg-white/5 text-white/40 border-white/5 hover:bg-white/10 hover:text-white/60'
    }`}
    aria-label={label}
    title={label}
  >
    {icon}
  </button>
);
