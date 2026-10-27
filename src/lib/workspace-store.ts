'use client';

import { createContext, useContext } from 'react';
import { Session, SessionKind, TreeNode } from '@/types';

export interface ScreenshotAttachment {
  path: string;
  dataUrl: string;
}

export interface WorkspaceState {
  // Current workspace tree rooted at the user's home Annot folder
  treeRoot: TreeNode | null;
  // Whether the tree is being loaded from disk
  treeLoading: boolean;
  // Currently selected node in the tree
  selectedNode: TreeNode | null;
  // Currently viewed PDF (subset of selection — clicking a pdf sets this)
  activePdf: TreeNode | null;
  // Currently active session folder path (where chat lives)
  activeSessionFolder: string | null;
  // Whether the active session is folder-wide or PDF-specific
  activeSessionKind: SessionKind | null;
  // PDF path for PDF-specific sessions
  activeSessionPdfPath: string | null;
  // Currently active Annot session id
  activeSessionId: string | null;
  // Whether the explorer sidebar is expanded
  explorerOpen: boolean;
  // Whether the chat panel is visible
  chatOpen: boolean;
  // Text currently selected by the user in the PDF viewer (outside highlight/erase mode)
  selectedText: string | null;
  // Screenshot regions captured from the PDF viewer, pending attachment to a chat query (in capture order)
  screenshots: ScreenshotAttachment[];
  // Whether the PDF viewer is in screenshot-capture (drag-to-select) mode
  screenshotMode: boolean;
  // Bumped whenever the PDF file itself was changed by an edit, undo or redo, so the viewer reloads it
  pdfRevision: number;
  // One-shot request for the viewer to scroll to a page (after an edit is applied)
  pdfJump: { page: number; nonce: number } | null;
  // One-shot request for the viewer to scroll to a page in the PDF that is already open (the assistant's "take me there")
  pdfGoto: { page: number; nonce: number } | null;
}

export interface WorkspaceActions {
  selectNode: (node: TreeNode) => void;
  clearSelection: () => void;
  openPdf: (pdf: TreeNode) => void;
  openSession: (session: Pick<Session, 'id' | 'folderPath' | 'sessionKind' | 'pdfPath'>) => void;
  closePdf: () => void;
  toggleExplorer: () => void;
  toggleChat: () => void;
  refreshTree: () => Promise<TreeNode | null>;
  setSelectedText: (text: string | null) => void;
  addScreenshot: (screenshot: ScreenshotAttachment) => void;
  removeScreenshot: (path: string) => void;
  clearScreenshots: () => void;
  setScreenshotMode: (active: boolean) => void;
  notifyPdfEdited: (page?: number) => void;
  goToPdfPage: (page: number) => void;
}

// Page (1-based) in view in the PDF viewer, or null when none is open. Deliberately not React state: it changes on
// every page flip while scrolling, and the chat only needs it at the moment a message is sent.
export const viewerPage: { current: number | null } = { current: null };

// For a Word document: describes what is at the top of the visible area, asked for when a chat message is sent.
export const viewerLocation: { current: (() => string | null) | null } = { current: null };

export type WorkspaceContextType = WorkspaceState & WorkspaceActions;

export const WorkspaceContext = createContext<WorkspaceContextType | null>(null);

export function useWorkspace(): WorkspaceContextType {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
