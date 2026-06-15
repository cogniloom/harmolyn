import React from 'react';
import { motion, type Variants } from 'framer-motion';

const easeOut = { duration: 0.25, ease: [0.16, 1, 0.3, 1] as const };

const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: easeOut },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.92, y: 12 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { ...easeOut, duration: 0.3 } },
  exit: { opacity: 0, scale: 0.95, y: 8, transition: { duration: 0.18 } },
};

export const ModalOverlay: React.FC<{
  children: React.ReactNode;
  onClose?: () => void;
  className?: string;
}> = ({ children, onClose, className = '' }) => (
  <motion.div
    className={`fixed inset-0 z-[110] bg-bg-0/90 backdrop-blur-xl flex items-center justify-center p-4 ${className}`}
    variants={fadeIn}
    initial="hidden"
    animate="visible"
    exit="exit"
    onClick={onClose}
  >
    <motion.div
      variants={scaleIn}
      initial="hidden"
      animate="visible"
      exit="exit"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>
  </motion.div>
);

export const FullScreenOverlay: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = '' }) => (
  <motion.div
    className={`absolute inset-0 z-[100] ${className}`}
    initial={{ opacity: 0, scale: 0.97 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.97 }}
    transition={easeOut}
  >
    {children}
  </motion.div>
);
