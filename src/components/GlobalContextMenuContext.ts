import { createContext, useContext, type ReactNode } from 'react';

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuSection {
  items: ContextMenuItem[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  sections: ContextMenuSection[];
}

interface ContextMenuContextValue {
  showMenu: (x: number, y: number, sections: ContextMenuSection[]) => void;
  closeMenu: () => void;
}

export const ContextMenuContext = createContext<ContextMenuContextValue>({
  showMenu: () => {},
  closeMenu: () => {},
});

export const useContextMenu = () => useContext(ContextMenuContext);
