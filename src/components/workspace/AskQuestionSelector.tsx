'use client';

import { useEffect, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';

import { AskQuestionDialog } from '@/components/workspace/AskQuestionDialog';

interface AskQuestionSelectorProps {
  folderPath: string | null;
  sessionId: string | null;
  model?: string;
  currentPdfPath?: string | null;
}

interface SelectionMenuState {
  text: string;
  x: number;
  y: number;
}

// Kept as its own component so selecting text in a chat reply only re-renders
// this small tree, not the whole ChatPanel (which would tear down and rebuild
// the assistant message DOM on every selection, collapsing the selection).
export function AskQuestionSelector({ folderPath, sessionId, model, currentPdfPath }: AskQuestionSelectorProps) {
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const [askQuestionSelection, setAskQuestionSelection] = useState<string | null>(null);

  useEffect(() => {
    const updateSelectionMenu = (event: MouseEvent | KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-ask-question-menu="true"]')) {
        return;
      }

      const selection = window.getSelection();

      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelectionMenu(null);
        return;
      }

      const text = selection.toString().trim();
      if (!text) {
        setSelectionMenu(null);
        return;
      }

      const anchorNode = selection.anchorNode;
      const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
      const scopeElement = anchorElement?.closest('[data-assistant-selectable="true"]');
      if (!scopeElement) {
        setSelectionMenu(null);
        return;
      }

      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelectionMenu(null);
        return;
      }

      setSelectionMenu({
        text,
        x: Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80),
        y: Math.max(rect.top, 48),
      });
    };

    document.addEventListener('mouseup', updateSelectionMenu);
    document.addEventListener('keyup', updateSelectionMenu);

    return () => {
      document.removeEventListener('mouseup', updateSelectionMenu);
      document.removeEventListener('keyup', updateSelectionMenu);
    };
  }, []);

  const handleOpenAskQuestion = () => {
    if (!selectionMenu) return;
    setAskQuestionSelection(selectionMenu.text);
    setSelectionMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <>
      {selectionMenu && (
        <div
          data-ask-question-menu="true"
          className="fixed z-50 -translate-x-1/2 -translate-y-full pb-2"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
        >
          <button
            onClick={handleOpenAskQuestion}
            className="flex items-center gap-1.5 rounded-lg bg-on-surface px-2.5 py-1.5 text-[11px] font-medium text-surface-container-lowest shadow-ambient transition-colors hover:opacity-90"
          >
            <MessageCircleQuestion size={12} strokeWidth={2} />
            Ask Question
          </button>
        </div>
      )}

      <AskQuestionDialog
        open={askQuestionSelection !== null}
        selectedText={askQuestionSelection ?? ''}
        folderPath={folderPath}
        sessionId={sessionId}
        model={model}
        currentPdfPath={currentPdfPath}
        onClose={() => setAskQuestionSelection(null)}
      />
    </>
  );
}
